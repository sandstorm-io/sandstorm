// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

var Crypto = Npm.require("crypto");
var Capnp = Npm.require("capnp");

var PersistentHandle = Capnp.importSystem("sandstorm/supervisor.capnp").PersistentHandle;
var SandstormCore = Capnp.importSystem("sandstorm/supervisor.capnp").SandstormCore;
var SandstormCoreFactory = Capnp.importSystem("sandstorm/backend.capnp").SandstormCoreFactory;
var PersistentOngoingNotification = Capnp.importSystem("sandstorm/supervisor.capnp").PersistentOngoingNotification;

function SandstormCoreImpl(grainId) {
  this.grainId = grainId;
}

var makeSandstormCore = function (grainId) {
  return new Capnp.Capability(new SandstormCoreImpl(grainId), SandstormCore);
};

function NotificationHandle(notificationId, saved) {
  this.notificationId = notificationId;
  this.saved = saved;
}

function makeNotificationHandle(notificationId, saved) {
  return new Capnp.Capability(new NotificationHandle(notificationId, saved), PersistentHandle);
}

function dropWakelock(grainId, wakeLockNotificationId) {
  waitPromise(useGrain(grainId, function (supervisor) {
    return supervisor.drop({wakeLockNotification: wakeLockNotificationId});
  }));
}

function dismissNotification(notificationId, callCancel) {
  var notification = Notifications.findOne({_id: notificationId});
  if (notification) {
    Notifications.remove({_id: notificationId});
    if (notification.ongoing) {
      // For some reason, Mongo returns an object that looks buffer-like, but isn't a buffer.
      // Only way to fix seems to be to copy it.
      var id = new Buffer(notification.ongoing);

      if (!callCancel) {
        dropInternal(id, {frontend: null});
      } else {
        var notificationCap = waitPromise(restoreInternal(id, {frontend: null})).cap;
        var castedNotification = notificationCap.castAs(PersistentOngoingNotification);
        dropInternal(id, {frontend: null});
        try {
          waitPromise(castedNotification.cancel());
          castedNotification.close();
          notificationCap.close();
        } catch (err) {
          if (err.kjType !== "disconnected") {
            // ignore disconnected errors, since cancel may shutdown the grain before the supervisor
            // responds.
            throw err;
          }
        }
      }
    }
  }
}

function hashSturdyRef(sturdyRef) {
  return Crypto.createHash("sha256").update(sturdyRef).digest("base64");
}

function generateSturdyRef() {
  return Random.secret();
}

Meteor.methods({
  dismissNotification: function (notificationId) {
    // This will remove notifications from the database and from view of the user.
    // For ongoing notifications, it will begin the process of cancelling and dropping them from
    // the app.
    var notification = Notifications.findOne({_id: notificationId});
    if (!notification) {
      throw new Meteor.Error(404, "Notification id not found.");
    } else if (notification.userId !== Meteor.userId()) {
      throw new Meteor.Error(403, "Notification does not belong to current user.");
    } else {
      dismissNotification(notificationId, true);
    }
  },
  readAllNotifications: function () {
    // Marks all notifications as read for the current user.
    if (!Meteor.userId()) {
      throw new Meteor.Error(403, "User not logged in.");
    }
    Notifications.update({userId: Meteor.userId()}, {$set: {isUnread: false}}, {multi: true});
  }
});

NotificationHandle.prototype.close = function () {
  var self = this;
  return inMeteor(function () {
    if (!self.saved) {
      dismissNotification(self.notificationId);
    }
  });
};

NotificationHandle.prototype.save = function (params) {
  var self = this;
  return inMeteor(function () {
    var sturdyRef = new Buffer(generateSturdyRef());
    var hashedSturdyRef = hashSturdyRef(sturdyRef);
    ApiTokens.insert({
      _id: hashedSturdyRef,
      frontendRef: {
        notificationHandle: self.notificationId
      },
      owner: params.sealFor,
    });
    self.saved = true;
    return {sturdyRef: sturdyRef};
  });
};

restoreInternal = function (sturdyRef, ownerPattern) {
  // Restores `sturdyRef`, checking first that its owner matches `ownerPattern`.
  var hashedSturdyRef = hashSturdyRef(sturdyRef);
  var token = ApiTokens.findOne(hashedSturdyRef);
  if (!token) {
    throw new Error("No token found to restore");
  }
  check(token.owner, ownerPattern);
  if (token.frontendRef) {
    if (token.frontendRef.notificationHandle) {
      var notificationId = token.frontendRef.notificationHandle;
      return {cap: makeNotificationHandle(notificationId, true)};
    } else {
      throw new Error("Unknown frontend token type.");
    }
  } else if (token.objectId) {
    if (token.objectId.appRef) {
      token.objectId.appRef = new Buffer(token.objectId.appRef);
    }
    return useGrain(token.grainId, function (supervisor) {
      return supervisor.restore(token.objectId);
    });
  } else {
    throw new Error("Unknown token type.");
  }
};

SandstormCoreImpl.prototype.restore = function (sturdyRef) {
  var self = this;
  return inMeteor(function () {
    return restoreInternal(sturdyRef, {grain: Match.ObjectIncluding({grainId: self.grainId})});
  });
};

function dropInternal (sturdyRef, ownerPattern) {
  // Drops `sturdyRef`, checking first that its owner matches `ownerPattern`.

  var hashedSturdyRef = hashSturdyRef(sturdyRef);
  var token = ApiTokens.findOne({_id: hashedSturdyRef});
  if (!token) {
    return;
  }
  check(token.owner, ownerPattern);

  if (token.frontendRef) {
    if (token.frontendRef.notificationHandle) {
      var notificationId = token.frontendRef.notificationHandle;
      ApiTokens.remove({_id: hashedSturdyRef});
      var anyToken = ApiTokens.findOne({"frontendRef.notificationHandle": notificationId});
      if (!anyToken) {
        // No other tokens referencing this notification exist, so dismiss the notification
        dismissNotification(notificationId);
      }
    } else {
      throw new Error("Unknown frontend token type.");
    }
  } else if (token.objectId) {
    if (token.objectId.wakeLockNotification) {
      dropWakelock(token.grainId, token.objectId.wakeLockNotification);
    } else {
      throw new Error("Unknown objectId token type.");
    }
  } else {
    throw new Error("Unknown token type.");
  }
}

SandstormCoreImpl.prototype.drop = function (sturdyRef) {
  var self = this;
  return inMeteor(function () {
    return dropInternal(sturdyRef, {grain: Match.ObjectIncluding({grainId: self.grainId})});
  });
};

SandstormCoreImpl.prototype.makeToken = function (ref, owner) {
  var self = this;
  return inMeteor(function () {
    var sturdyRef = new Buffer(generateSturdyRef());
    var hashedSturdyRef = hashSturdyRef(sturdyRef);
    ApiTokens.insert({
      _id: hashedSturdyRef,
      grainId: self.grainId,
      objectId: ref,
      owner: owner
    });

    return {
      token: sturdyRef
    };
  });
};

SandstormCoreImpl.prototype.getOwnerNotificationTarget = function() {
  var grainId = this.grainId;
  return {owner: {addOngoing: function(displayInfo, notification) {
    return inMeteor(function () {
      var grain = Grains.findOne({_id: grainId});
      if (!grain) {
        throw new Error("Grain not found.");
      }
      var castedNotification = notification.castAs(PersistentOngoingNotification);
      var wakelockToken = waitPromise(castedNotification.save()).sturdyRef;

      // We have to close both the casted cap and the original. Perhaps this should be fixed in
      // node-capnp?
      castedNotification.close();
      notification.close();
      var notificationId = Notifications.insert({
        ongoing: wakelockToken,
        grainId: grainId,
        userId: grain.userId,
        text: displayInfo.caption,
        timestamp: new Date(),
        isUnread: true
      });

      return {handle: makeNotificationHandle(notificationId, false)};
    });
  }}};
};

function SandstormCoreFactoryImpl() {
}

SandstormCoreFactoryImpl.prototype.getSandstormCore = function (grainId){
  return {core: makeSandstormCore(grainId)};
};

makeSandstormCoreFactory = function () {
  return new Capnp.Capability(new SandstormCoreFactoryImpl(), SandstormCoreFactory);
};

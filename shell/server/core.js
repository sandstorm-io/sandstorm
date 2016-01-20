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

const Crypto = Npm.require('crypto');
const Capnp = Npm.require('capnp');

const PersistentHandle = Capnp.importSystem('sandstorm/supervisor.capnp').PersistentHandle;
const SandstormCore = Capnp.importSystem('sandstorm/supervisor.capnp').SandstormCore;
const SandstormCoreFactory = Capnp.importSystem('sandstorm/backend.capnp').SandstormCoreFactory;
const PersistentOngoingNotification = Capnp.importSystem('sandstorm/supervisor.capnp').PersistentOngoingNotification;

class SandstormCoreImpl {
  constructor(grainId) {
    this.grainId = grainId;
  }

  restore(sturdyRef, requiredPermissions) {
    const _this = this;
    return inMeteor(() => {
      const hashedSturdyRef = hashSturdyRef(sturdyRef);
      const token = ApiTokens.findOne(hashedSturdyRef);
      const requirements = [
        {
          tokenValid: hashedSturdyRef,
        },
      ];

      if (requiredPermissions && token.owner.grain.introducerIdentity) {
        requirements.push({
          permissionsHeld: {
            permissions: requiredPermissions,
            identityId: token.owner.grain.introducerIdentity,
            grainId: _this.grainId,
          },
        });
      }

      return restoreInternal(hashedSturdyRef,
                             {grain: Match.ObjectIncluding({grainId: _this.grainId})},
                             requirements, sturdyRef);
    });
  }

  drop(sturdyRef) {
    const _this = this;
    return inMeteor(() => {
      return dropInternal(sturdyRef, {grain: Match.ObjectIncluding({grainId: _this.grainId})});
    });
  }

  makeToken(ref, owner, requirements) {
    const _this = this;
    return inMeteor(() => {
      const sturdyRef = new Buffer(generateSturdyRef());
      const hashedSturdyRef = hashSturdyRef(sturdyRef);
      ApiTokens.insert({
        _id: hashedSturdyRef,
        grainId: _this.grainId,
        objectId: ref,
        owner: owner,
        created: new Date(),
        requirements: requirements,
      });

      return {
        token: sturdyRef,
      };
    });
  }

  makeChildToken(parent, owner, requirements) {
    const _this = this;
    return inMeteor(() => {
      return makeChildTokenInternal(hashSturdyRef(parent), owner, requirements, _this.grainId);
    });
  }

  getOwnerNotificationTarget() {
    const grainId = this.grainId;
    return {
      owner: {
        addOngoing: (displayInfo, notification) => {
          return inMeteor(() => {
            const grain = Grains.findOne({_id: grainId});
            if (!grain) {
              throw new Error('Grain not found.');
            }

            const castedNotification = notification.castAs(PersistentOngoingNotification);
            const wakelockToken = waitPromise(castedNotification.save()).sturdyRef;

            // We have to close both the casted cap and the original. Perhaps this should be fixed in
            // node-capnp?
            castedNotification.close();
            notification.close();
            const notificationId = Notifications.insert({
              ongoing: wakelockToken,
              grainId: grainId,
              userId: grain.userId,
              text: displayInfo.caption,
              timestamp: new Date(),
              isUnread: true,
            });

            return {handle: makeNotificationHandle(notificationId, false)};
          });
        },
      },
    };
  }
}

const makeSandstormCore = (grainId) => {
  return new Capnp.Capability(new SandstormCoreImpl(grainId), SandstormCore);
};

class NotificationHandle {
  constructor(notificationId, saved) {
    this.notificationId = notificationId;
    this.saved = saved;
  }

  close() {
    const _this = this;
    return inMeteor(() => {
      if (!_this.saved) {
        dismissNotification(_this.notificationId);
      }
    });
  }

  save(params) {
    return saveFrontendRef({notificationHandle: this.notificationId}, params.sealFor);
  }
}

function makeNotificationHandle(notificationId, saved) {
  return new Capnp.Capability(new NotificationHandle(notificationId, saved), PersistentHandle);
}

function dropWakelock(grainId, wakeLockNotificationId) {
  waitPromise(globalBackend.useGrain(grainId, (supervisor) => {
    return supervisor.drop({wakeLockNotification: wakeLockNotificationId});
  }));
}

function dismissNotification(notificationId, callCancel) {
  const notification = Notifications.findOne({_id: notificationId});
  if (notification) {
    Notifications.remove({_id: notificationId});
    if (notification.ongoing) {
      // For some reason, Mongo returns an object that looks buffer-like, but isn't a buffer.
      // Only way to fix seems to be to copy it.
      const id = new Buffer(notification.ongoing);

      if (!callCancel) {
        dropInternal(id, {frontend: null});
      } else {
        const notificationCap = restoreInternal(hashSturdyRef(id), {frontend: null}).cap;
        const castedNotification = notificationCap.castAs(PersistentOngoingNotification);
        dropInternal(id, {frontend: null});
        try {
          waitPromise(castedNotification.cancel());
          castedNotification.close();
          notificationCap.close();
        } catch (err) {
          if (err.kjType !== 'disconnected') {
            // ignore disconnected errors, since cancel may shutdown the grain before the supervisor
            // responds.
            throw err;
          }
        }
      }
    } else if (notification.appUpdates) {
      _.forEach(notification.appUpdates, (app, appId) => {
        deletePackage(app.packageId);
      });
    }
  }
}

hashSturdyRef = (sturdyRef) => {
  return Crypto.createHash('sha256').update(sturdyRef).digest('base64');
};

function generateSturdyRef() {
  return Random.id(22);
}

Meteor.methods({
  dismissNotification(notificationId) {
    // This will remove notifications from the database and from view of the user.
    // For ongoing notifications, it will begin the process of cancelling and dropping them from
    // the app.

    check(notificationId, String);

    const notification = Notifications.findOne({_id: notificationId});
    if (!notification) {
      throw new Meteor.Error(404, 'Notification id not found.');
    } else if (notification.userId !== Meteor.userId()) {
      throw new Meteor.Error(403, 'Notification does not belong to current user.');
    } else {
      dismissNotification(notificationId, true);
    }
  },

  readAllNotifications() {
    // Marks all notifications as read for the current user.
    if (!Meteor.userId()) {
      throw new Meteor.Error(403, 'User not logged in.');
    }

    Notifications.update({userId: Meteor.userId()}, {$set: {isUnread: false}}, {multi: true});
  },
  offerExternalWebSession(grainId, identityId, url) {
    check(grainId, String);
    check(identityId, String);
    check(url, String);

    const db = this.connection.sandstormDb;

    // Check that the the identityId matches and has permission to view this grain
    if (!db.userHasIdentity(Meteor.userId(), identityId)) {
      throw new Meteor.Error(403, "Logged in user doesn't own the supplied identity.");
    }
    const requirement = {
      permissionsHeld: {
        grainId: grainId,
        identityId: identityId,
        permissions: [], // We only want to check for the implicit view permission
      },
    };
    if (!checkRequirements([requirement])) {
      throw new Meteor.Error(403, "This identity doesn't have view permissions to the grain.");
    }
    const requirements = []; // We don't actually want the user's permission check as a requirement.
    const grainOwner = {grain: {
      grainId: grainId,
      introducerIdentity: identityId,
      saveLabel: url + " websession",
    }};
    const sturdyRef = waitPromise(saveFrontendRef(
      {externalWebSession: {url: url}}, grainOwner, requirements)).sturdyRef;

    return sturdyRef.toString();
  }
});

saveFrontendRef = (frontendRef, owner, requirements) => {
  return inMeteor(() => {
    const sturdyRef = new Buffer(generateSturdyRef());
    const hashedSturdyRef = hashSturdyRef(sturdyRef);
    ApiTokens.insert({
      _id: hashedSturdyRef,
      frontendRef: frontendRef,
      owner: owner,
      created: new Date(),
      requirements: requirements,
    });
    return {sturdyRef: sturdyRef};
  });
};

checkRequirements = (requirements) => {
  if (!requirements) {
    return true;
  }

  for (let i in requirements) {
    const requirement = requirements[i];
    if (requirement.tokenValid) {
      const token = ApiTokens.findOne({_id: requirement.tokenValid}, {fields: {requirements: 1}});
      if (!checkRequirements(token.requirements)) {
        return false;
      }
    } else if (requirement.permissionsHeld) {
      const p = requirement.permissionsHeld;
      const viewInfo = Grains.findOne(p.grainId, {fields: {cachedViewInfo: 1}}).cachedViewInfo;
      const currentPermissions = SandstormPermissions.grainPermissions(
        globalDb, {grain: {_id: p.grainId, identityId: p.identityId}}, viewInfo || {});
      if (!currentPermissions) {
        return false;
      }

      for (let ii = 0; ii < p.permissions.length; ++ii) {
        if (p.permissions[ii] && !currentPermissions[ii]) {
          return false;
        }
      }
    } else if (requirement.userIsAdmin) {
      if (!isAdminById(requirement.userIsAdmin)) {
        return false;
      }
    } else {
      throw new Meteor.Error(403, 'Unknown requirement');
    }
  }

  return true;
};

restoreInternal = (tokenId, ownerPattern, requirements, parentToken) => {
  // Restores `sturdyRef`, checking first that its owner matches `ownerPattern`.
  // parentToken and requirements are optional params that are only used in the case of an objectId
  // token
  const token = ApiTokens.findOne(tokenId);
  if (!token) {
    throw new Meteor.Error(403, 'No token found to restore');
  }

  if (token.revoked) {
    throw new Meteor.Error(403, 'Token has been revoked');
  }

  check(token.owner, ownerPattern);
  if (!checkRequirements(token.requirements)) {
    throw new Meteor.Error(403, 'Requirements not satisfied.');
  }

  if (token.expires && token.expires.getTime() <= Date.now()) {
    throw new Meteor.Error(403, 'Authorization token expired');
  }

  if (token.expiresIfUnused) {
    if (token.expiresIfUnused.getTime() <= Date.now()) {
      throw new Meteor.Error(403, 'Authorization token expired');
    } else {
      // It's getting used now, so clear the expiresIfUnused field.
      ApiTokens.update(token._id, {$set: {expiresIfUnused: null}});
    }
  }

  if (token.frontendRef) {
    if (token.frontendRef.notificationHandle) {
      const notificationId = token.frontendRef.notificationHandle;
      return {cap: makeNotificationHandle(notificationId, true)};
    } else if (token.frontendRef.ipNetwork) {
      return {cap: makeIpNetwork(tokenId)};
    } else if (token.frontendRef.ipInterface) {
      return {cap: makeIpInterface(tokenId)};
    } else if (token.frontendRef.externalWebSession) {
      return {cap: makeExternalWebSession(token.frontendRef.externalWebSession.url)};
    } else {
      throw new Meteor.Error(500, 'Unknown frontend token type.');
    }
  } else if (token.objectId) {
    if (!checkRequirements(requirements)) {
      throw new Meteor.Error(403, 'Requirements not satisfied.');
    }

    if (token.objectId.appRef) {
      token.objectId.appRef = new Buffer(token.objectId.appRef);
    }

    return waitPromise(globalBackend.useGrain(token.grainId, (supervisor) => {
      return supervisor.restore(token.objectId, requirements, parentToken);
    }));
  } else if (token.parentToken) {
    return restoreInternal(token.parentToken, Match.Any, requirements, parentToken);
  } else {
    throw new Meteor.Error(500, 'Unknown token type.');
  }
};

function dropInternal(sturdyRef, ownerPattern) {
  // Drops `sturdyRef`, checking first that its owner matches `ownerPattern`.

  const hashedSturdyRef = hashSturdyRef(sturdyRef);
  const token = ApiTokens.findOne({_id: hashedSturdyRef});
  if (!token) {
    return;
  }

  check(token.owner, ownerPattern);

  if (token.frontendRef) {
    if (token.frontendRef.notificationHandle) {
      const notificationId = token.frontendRef.notificationHandle;
      ApiTokens.remove({_id: hashedSturdyRef});
      const anyToken = ApiTokens.findOne({'frontendRef.notificationHandle': notificationId});
      if (!anyToken) {
        // No other tokens referencing this notification exist, so dismiss the notification
        dismissNotification(notificationId);
      }
    } else {
      throw new Error('Unknown frontend token type.');
    }
  } else if (token.objectId) {
    if (token.objectId.wakeLockNotification) {
      dropWakelock(token.grainId, token.objectId.wakeLockNotification);
    } else {
      throw new Error('Unknown objectId token type.');
    }
  } else {
    throw new Error('Unknown token type.');
  }
}

makeChildTokenInternal = (hashedParent, owner, requirements, grainId) => {
  const sturdyRef = new Buffer(generateSturdyRef());
  const hashedSturdyRef = hashSturdyRef(sturdyRef);

  requirements = requirements.filter((requirement) => {
    return requirement.tokenValid !== hashedParent;
  });

  const tokenInfo = {
    _id: hashedSturdyRef,
    parentToken: hashedParent,
    owner: owner,
    created: new Date(),
    requirements: requirements,
  };
  if (grainId) {
    tokenInfo.grainId = grainId;
  }

  ApiTokens.insert(tokenInfo);

  return {
    token: sturdyRef,
  };
};

function SandstormCoreFactoryImpl() {
}

SandstormCoreFactoryImpl.prototype.getSandstormCore = (grainId) => {
  return {core: makeSandstormCore(grainId)};
};

makeSandstormCoreFactory = () => {
  return new Capnp.Capability(new SandstormCoreFactoryImpl(), SandstormCoreFactory);
};

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

// This file implements /grain, i.e. the main view into an app.

if (Meteor.isServer) {
  Grains.allow({
    update: function (userId, grain, fieldNames) {
      // Allow owner to rename grain.
      return userId && grain.userId === userId &&
          fieldNames.length === 1 && fieldNames[0] === "title";
    }
  });

  Meteor.publish("grainTitle", function (grainId) {
    check(grainId, String);

    // You can get the title of an arbitrary grain by ID, but we hide the other metadata, because:
    // - Revealing the package ID would allow anyone with whom you share a grain to install the
    //   same app, preventing private apps.
    // - Revealing the owner's user ID might be undesirable for plausible deniability reasons.
    //
    // Except, we actually do need to know if the caller is the grain's owner since we display
    // extra functionality in that case. So we'll do an owner check first and if that passes return
    // additional info.
    if (Grains.find({_id: grainId, userId: this.userId}).count() > 0) {
      return Grains.find(grainId, { fields: { title: 1, userId: 1 } });
    } else {
      return Grains.find(grainId, { fields: { title: 1 } });
    }
  });

  Meteor.publish("grainSize", function (sessionId) {
    // Publish pseudo-collection containing the size of the grain opened in the given session.

    var self = this;
    var stopped = false;
    var promise = getGrainSize(sessionId);

    function getNext(oldSize) {
      promise = getGrainSize(sessionId, oldSize);
      promise.then(function (size) {
        if (!stopped) {
          self.changed("grainSizes", sessionId, {size: size});
          getNext(size);
        }
      }, function (err) {
        if (!stopped) {
          self.error(err);
        }
      });
    }

    promise.then(function (size) {
      if (!stopped) {
        self.added("grainSizes", sessionId, {size: size});
        self.ready();
        getNext(size);
      }
    }, function (err) {
      if (!stopped) {
        self.error(err);
      }
    });

    self.onStop(function () {
      stopped = true;
      promise.cancel();
    });
  });
}

var GrainSizes = new Meteor.Collection("grainSizes");
// Pseudo-collection from above publish.

Meteor.methods({
  deleteGrain: function (grainId) {
    check(grainId, String);

    if (this.userId) {
      var grain = Grains.findOne({_id: grainId, userId: this.userId});
      if (grain) {
        Grains.remove(grainId);
        if (grain.lastUsed) {
          DeleteStats.insert({type: "grain", lastActive: grain.lastUsed});
        }
        if (!this.isSimulation) {
          deleteGrain(grainId);
        }
      }
    }
  }
});

if (Meteor.isClient) {
  Template.grain.events({
    "click #grainTitle": function (event) {
      var title = window.prompt("Set new title:", this.title);
      if (title) {
        Grains.update(this.grainId, {$set: {title: title}});
      }
    },
    "click #deleteGrain": function (event) {
      if (window.confirm("Really delete this grain?")) {
        Meteor.call("deleteGrain", this.grainId);
        Router.go("root");
      }
    },
    "click #openDebugLog": function (event) {
      window.open("/grain/" + this.grainId + "/log", "_blank",
          "menubar=no,status=no,toolbar=no,width=700,height=700");
    },
    "click #backupGrain": function (event) {
      Meteor.call("backupGrain", this.grainId, function (err, id) {
        if (err) {
          alert("Backup failed: " + err); // TODO(someday): make this better UI
        } else {
          window.location = "/downloadBackup/" + id;
        }
      });
    },
    "click #restartGrain": function (event) {
      var sessionId = this.sessionId;
      var grainId = this.grainId;

      Meteor.call("shutdownGrain", grainId, function (err) {
        if (err) {
          alert("Restart failed: " + err); // TODO(someday): make this better UI
        } else {
          var frame = document.getElementById("grain-frame");
          frame.src = frame.src;
        }
      });
    }
  });

  Template.grain.helpers({
    grainSize: function () {
      if (this.sessionId) {
        sizeEntry = GrainSizes.findOne(this.sessionId);
        if (sizeEntry) {
          var size = sizeEntry.size;
          var suffix = "B";
          if (size > 1000000000) {
            size = size / 1000000000;
            suffix = "GB";
          } else if (size > 1000000) {
            size = size / 1000000;
            suffix = "MB";
          } else if (size > 1000) {
            size = size / 1000;
            suffix = "kB";
          }
          return "(" + size.toPrecision(3) + suffix + ")";
        }
      }
      return "";
    }
  });

  var currentSessionId;
  var sessionGrainSizeSubscription;

  function setCurrentSessionId(sessionId) {
    if (sessionGrainSizeSubscription) {
      sessionGrainSizeSubscription.stop();
      sessionGrainSizeSubscription = undefined;
    }
    currentSessionId = sessionId;
    if (sessionId) {
      sessionGrainSizeSubscription = Meteor.subscribe("grainSize", sessionId);
    }
  }

  // Send keep-alive every now and then.
  Meteor.setInterval(function () {
    if (currentSessionId) {
      // TODO(soon):  Investigate what happens in background tabs.  Maybe arrange to re-open the
      //   app if it dies while in the background.
      console.log("keepalive: ", new Date());
      Meteor.call("keepSessionAlive", currentSessionId, function (error, result) {
        if (!result) {
          // TODO(soon):  Make a UI for this.
          //   Hmm... Actually this may not be a real problem since the grain will be restarted
          //   on the next request. The only real problem is if the proxy has been removed on the
          //   server side, so perhaps check for that.
          console.error("Session seems to have died.  Please reload to fix.");
        }
      });
    }
  }, 60000);

  var blockedReload;
  var blockedReloadDep = new Deps.Dependency;
  var explicitlyUnblocked = false;
  Reload._onMigrate(undefined, function (retry) {
    if (currentSessionId && !explicitlyUnblocked) {
      console.log("New version ready, but blocking reload because an app is open.");
      blockedReload = retry;
      blockedReloadDep.changed();
      return false;
    } else {
      return [true];
    }
  });

  isUpdateBlocked = function () {
    blockedReloadDep.depend();
    return !!blockedReload;
  }
  unblockUpdate = function () {
    if (blockedReload) {
      blockedReload();
      explicitlyUnblocked = true;
      blockedReloadDep.changed();
    }
  }
}

if (Meteor.isClient) {
  // Every time the set of dev apps changes, force a reload of any open session.
  Deps.autorun(function () {
    var timestampSum = 0;
    DevApps.find().forEach(function (app) { timestampSum += app.timestamp; });

    var toRemove = [];
    for (var key in Session.keys) {
      if (key.slice(0, 8) === "session-") {
        toRemove.push(key);
      }
    }
    toRemove.forEach(function (key) { Session.set(key, undefined); });
  });
}

if (Meteor.isClient) {
  function maybeScrollLog() {
    var elem = document.getElementById("grainLog");
    if (elem) {
      // The log already exsits. It's about to be updated. Check if it's scrolled to the bottom
      // before the update.
      if (elem.scrollHeight - elem.scrollTop === elem.clientHeight) {
        // Indeed, so we want to scroll it back to the bottom after the update.
        Deps.afterFlush(function () { scrollLogToBottom(elem); });
      }
    } else {
      // No element exists yet, but it's probably about to be created, in which case we definitely
      // want to scroll it.
      Deps.afterFlush(function () {
        var elem2 = document.getElementById("grainLog");
        if (elem2) scrollLogToBottom(elem2);
      });
    }
  }

  function scrollLogToBottom(elem) {
    elem.scrollTop = elem.scrollHeight;
  }
}

GrainLog = new Meteor.Collection("grainLog");
// Pseudo-collection created by subscribing to "grainLog", implemented in proxy.js.

Router.map(function () {
  this.route("grain", {
    path: "/grain/:grainId",

    waitOn: function () {
      // TODO(perf):  Do these subscriptions get stop()ed when the user browses away?
      return [
        Meteor.subscribe("grainTitle", this.params.grainId),
        Meteor.subscribe("devApps"),
        Meteor.subscribe("credentials")
      ];
    },

    data: function () {
      // Make sure that if any dev apps are published or removed, we refresh the grain view.
      setCurrentSessionId(undefined);
      var grainId = this.params.grainId;
      var grain = Grains.findOne(grainId);
      if (!grain) {
        return { grainId: grainId, title: "Invalid Grain", error: "No such grain." };
      }

      var result = {
        grainId: grainId,
        title: grain.title,
        isOwner: grain.userId && grain.userId === Meteor.userId()
      };

      var err = Session.get("session-" + grainId + "-error");
      if (err) {
        result.error = err;
        return result;
      }

      var session = Session.get("session-" + grainId);
      if (session) {
        setCurrentSessionId(session.sessionId);
        result.appOrigin = document.location.protocol + "//" + makeWildcardHost(session.hostId);
        result.sessionId = session.sessionId;
        return result;
      } else {
        Meteor.call("openSession", grainId, function (error, session) {
          if (error) {
            Session.set("session-" + grainId + "-error", error.message);
          } else {
            Session.set("session-" + grainId, session);
            Session.set("session-" + grainId + "-error", undefined);
          }
        });
        return result;
      }
    },

    onStop: function () {
      setCurrentSessionId(undefined);
      unblockUpdate();
    }
  });

  this.route("grainLog", {
    path: "/grain/:grainId/log",
    layoutTemplate: "lightLayout",

    waitOn: function () {
      // TODO(perf):  Do these subscriptions get stop()ed when the user browses away?
      return [
        Meteor.subscribe("grainTitle", this.params.grainId),
        Meteor.subscribe("grainLog", this.params.grainId)
      ];
    },

    data: function () {
      maybeScrollLog();
      return {
        title: Grains.findOne(this.params.grainId).title,
        html: AnsiUp.ansi_to_html(GrainLog.find({}, {$sort: {_id: 1}})
            .map(function (entry) { return entry.text; })
            .join(""), {use_classes:true})
      };
    }
  });
});

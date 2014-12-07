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

  ApiTokens.allow({
    remove: function (userId, token) {
      return userId && token.userId === userId;
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
    var titleInfo;
    if (Grains.find({_id: grainId, userId: this.userId}).count() > 0) {
      titleInfo = Grains.find(grainId, { fields: { title: 1, userId: 1 } });
    } else {
      titleInfo = Grains.find(grainId, { fields: { title: 1 } });
    }

    if (this.userId) {
      // Also publish API tokens belonging to the user, so that they may be revoked.
      return [titleInfo, ApiTokens.find({grainId: grainId, userId: this.userId})];
    } else {
      return titleInfo;
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

  function cleanupExpiredTokens() {
    var now = new Date();
    ApiTokens.remove({expires: {$lt: now}});
  }

  Meteor.setInterval(cleanupExpiredTokens, 3600000);
}

var GrainSizes = new Mongo.Collection("grainSizes");
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
          Meteor.call("deleteUnusedPackages", grain.appId);
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
        Session.set("showMenu", false);
        Meteor.call("deleteGrain", this.grainId);
        Router.go("root");
      }
    },
    "click #openDebugLog": function (event) {
      window.open("/grainlog/" + this.grainId, "_blank",
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
    },
    "click #showApiToken": function (event) {
      if (Session.get("show-api-token")) {
        Session.set("show-api-token", false);
      } else {
        Session.set("show-api-token", true);
      }
    },
    "click #api-token-popup-closer": function (event) {
      Session.set("show-api-token", false);
    },
    "click #newApiToken": function (event) {
      var grainId = this.grainId;
      Session.set("api-token-" + grainId, "pending");
      Meteor.call("newApiToken", grainId, document.getElementById("api-token-petname").value,
          function (error, result) {
        if (error) {
          console.error(error.stack);
        } else {
          Session.set("api-token-" + grainId, result.endpointUrl + "#" + result.token);
          Meteor.setTimeout(function() {
            document.getElementById("apiTokenText").select();
          }, 0);
        }
      });
    },
    "click #resetApiToken": function (event) {
      Session.set("api-token-" + this.grainId, undefined);
    },
    "click button.revoke-token": function (event) {
      ApiTokens.remove(event.currentTarget.getAttribute("data-token-id"));
    },
    "click #homelink-button": function (event) {
      event.preventDefault();
      Session.set("showMenu", false);
      Router.go("root", {});
    },
    "click #menu-closer": function (event) {
      event.preventDefault();
      Session.set("showMenu", false);
    },
    "click #api-token-popup .copy-me": function(event) {
      event.preventDefault();
      if (document.body.createTextRange) {
        var range = document.body.createTextRange();
        range.moveToElementText(event.currentTarget);
        range.select();
      } else if (window.getSelection) {
        var selection = window.getSelection();
        var range = document.createRange();
        range.selectNodeContents(event.currentTarget);
        selection.removeAllRanges();
        selection.addRange(range);
      }
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
    },

    dateString: function (date) { return makeDateString(date); }
  });

  var currentSessionId;
  var currentAppOrigin;
  var currentGrainId;
  var sessionGrainSizeSubscription;

  function setCurrentSessionId(sessionId, appOrigin, grainId) {
    if (sessionGrainSizeSubscription) {
      sessionGrainSizeSubscription.stop();
      sessionGrainSizeSubscription = undefined;
    }
    currentSessionId = sessionId;
    currentAppOrigin = appOrigin;
    currentGrainId = grainId;
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

  // Message handler for changing path in user's URL bar
  Meteor.startup(function () {
    var messageListener = function (event) {
      if (event.origin !== currentAppOrigin) {
        // Note: Meteor apparently likes to postMessage() to itself sometimes, so we really should
        //   ignore any message not from our app.
        return;
      }

      if (event.data.setPath) {
        window.history.replaceState({}, "", "/grain/" +
            currentGrainId + event.data.setPath);
      } else {
        console.log("postMessage from app not understood: " + event.data);
      }
    };

    window.addEventListener("message", messageListener, false);
  });

  var blockedReload;
  var blockedReloadDep = new Tracker.Dependency;
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
  function maybeScrollLog() {
    var elem = document.getElementById("grainLog");
    if (elem) {
      // The log already exists. It's about to be updated. Check if it's scrolled to the bottom
      // before the update.
      if (elem.scrollHeight - elem.scrollTop === elem.clientHeight) {
        // Indeed, so we want to scroll it back to the bottom after the update.
        Tracker.afterFlush(function () { scrollLogToBottom(elem); });
      }
    } else {
      // No element exists yet, but it's probably about to be created, in which case we definitely
      // want to scroll it.
      Tracker.afterFlush(function () {
        var elem2 = document.getElementById("grainLog");
        if (elem2) scrollLogToBottom(elem2);
      });
    }
  }

  function scrollLogToBottom(elem) {
    elem.scrollTop = elem.scrollHeight;
  }
}

GrainLog = new Mongo.Collection("grainLog");
// Pseudo-collection created by subscribing to "grainLog", implemented in proxy.js.

Router.map(function () {
  this.route("grain", {
    path: "/grain/:grainId/:path(.*)?",

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
      setCurrentSessionId(undefined, undefined, undefined);
      var grainId = this.params.grainId;
      var grain = Grains.findOne(grainId);
      if (!grain) {
        return { grainId: grainId, title: "Invalid Grain", error: "No such grain." };
      }

      var apiToken = Session.get("api-token-" + grainId);

      var result = {
        grainId: grainId,
        title: grain.title,
        isOwner: grain.userId && grain.userId === Meteor.userId(),
        apiToken: apiToken,
        apiTokenPending: apiToken === "pending",
        showApiToken: Session.get("show-api-token"),
        existingTokens: ApiTokens.find({grainId: grainId, userId: Meteor.userId()}).fetch(),
        showMenu: Session.get("showMenu")
      };

      self = this;
      var clearError = function() { self.state.set("error", undefined); };
      DevApps.find().observeChanges({
        added : clearError,
        removed: clearError
      });

      var err = self.state.get("error");
      if (err) {
        result.error = err;
        return result;
      }

      var session = Sessions.findOne({grainId: grainId});
      if (session) {
        result.appOrigin = document.location.protocol + "//" + makeWildcardHost(session.hostId);
        setCurrentSessionId(session._id, result.appOrigin, grainId);
        result.sessionId = session._id;
        result.path = encodeURIComponent("/" + (self.params.path || ""));
        return result;
      } else {
        if (self.state.get("openingSession")) {
          return result;
        }

        self.state.set("openingSession", true);
        Meteor.call("openSession", grainId, function (error, session) {
          if (error) {
            self.state.set("error", error.message);
            self.state.set("openingSession", undefined);
          } else {
            var subscription = Meteor.subscribe("sessions", session.sessionId);
            Sessions.find({_id : session.sessionId}).observeChanges({
              removed: function(session) {
                subscription.stop();
              },
              added: function(session) {
                self.state.set("openingSession", undefined);
              }
            });
          }
        });
        return result;
      }
    },

    onStop: function () {
      setCurrentSessionId(undefined, undefined, undefined);
      unblockUpdate();
    }
  });

  this.route("grainLog", {
    path: "/grainlog/:grainId",
    layoutTemplate: "lightLayout",

    waitOn: function () {
      // TODO(perf):  Do these subscriptions get stop()ed when the user browses away?
      return [
        Meteor.subscribe("grainTitle", this.params.grainId),
        Meteor.subscribe("grainLog", this.params.grainId)
      ];
    },

    data: function () {
      if (this.ready()) {
        maybeScrollLog();
        return {
          title: Grains.findOne(this.params.grainId).title,
          html: AnsiUp.ansi_to_html(GrainLog.find({}, {$sort: {_id: 1}})
              .map(function (entry) { return entry.text; })
              .join(""), {use_classes:true})
        };
      }
    }
  });
});

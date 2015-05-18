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

var DEFAULT_TITLE = "Sandstorm";

if (Meteor.isServer) {
  Grains.allow({
    update: function (userId, grain, fieldNames) {
      // Allow owner to rename or privatize grain.
      return userId && grain.userId === userId &&
          ((fieldNames.length === 1 && fieldNames[0] === "title")
           || (fieldNames.length === 1 && fieldNames[0] === "private"));
    }
  });

  ApiTokens.allow({
    update: function (userId, apiToken, fieldNames) {
      // Allow owner to change the petname.
      return userId && apiToken.userId === userId &&
        (fieldNames.length === 1 && fieldNames[0] === "petname");
    },
    remove: function (userId, token) {
      return userId && token.userId === userId;
    }
  });

  RoleAssignments.allow({
    update: function (userId, roleAssignment, fieldNames) {
      // Allow recipient to rename their reference to a shared grain.
      return (userId && roleAssignment.recipient === userId &&
              fieldNames.length === 1 && fieldNames[0] === "title")
        || (userId && roleAssignment.sharer === userId &&
            fieldNames.length === 1 && fieldNames[0] === "active");
    }
  });

  Meteor.publish("grainTopBar", function (grainId) {
    check(grainId, String);
    var self = this;

    // Alice is allowed to know Bob's display name if Bob has received a role assignment from Alice
    // for *any* grain.
    var handle = RoleAssignments.find({sharer: this.userId}).observe({
      added: function(roleAssignment) {
        var user = Meteor.users.findOne(roleAssignment.recipient);
        if (user) {
          self.added("displayNames", user._id, {displayName: user.profile.name});
        }
      },
    });
    this.onStop(function() { handle.stop(); });
    return [Grains.find({_id : grainId, $or: [{userId: this.userId}, {private: {$ne: true}}]},
                        {fields: {title: 1, userId: 1, private: 1}}),
            ApiTokens.find({grainId: grainId, userId: this.userId}),
            RoleAssignments.find({$or : [{sharer: this.userId}, {recipient: this.userId}]}),
           ];
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
          if (err.type === "disconnected") {
            self.stop();
          } else {
            self.error(err);
          }
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
        if (err.type === "disconnected") {
          self.stop();
        } else {
          self.error(err);
        }
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
var DisplayNames = new Mongo.Collection("displayNames");
// Pseudo-collections published above.

Meteor.methods({
  deleteGrain: function (grainId) {
    check(grainId, String);

    if (this.userId) {
      var grain = Grains.findOne({_id: grainId, userId: this.userId});
      if (grain) {
        Grains.remove(grainId);
        ApiTokens.remove({grainId : grainId});
        if (grain.lastUsed) {
          DeleteStats.insert({type: "grain", lastActive: grain.lastUsed});
        }
        if (!this.isSimulation) {
          waitPromise(deleteGrain(grainId, this.userId));
          Meteor.call("deleteUnusedPackages", grain.appId);
        }
      }
    }
  },
  deleteRoleAssignments: function (grainId) {
    check(grainId, String);

    if (this.userId) {
      RoleAssignments.remove({grainId: grainId, recipient: this.userId});
    }
  },
});

if (Meteor.isClient) {
  Template.grain.events({
    "click #grainTitle": function (event) {
      var title = window.prompt("Set new title:", this.title);
      if (title) {
        if (this.isOwner) {
          Grains.update(this.grainId, {$set: {title: title}});
        } else {
          var roleAssignment = RoleAssignments.findOne({grainId: this.grainId,
                                                        recipient: Meteor.userId()},
                                                       {sort:{created:1}});
          if (roleAssignment) {
            RoleAssignments.update(roleAssignment._id,
                                   {$set: {title : title}});
          }
        }
      }
    },
    "click #deleteGrain": function (event) {
      if (this.isOwner) {
        if (window.confirm("Really delete this grain?")) {
          Session.set("showMenu", false);
          Meteor.call("deleteGrain", this.grainId);
          Router.go("root");
        }
      } else {
        if (window.confirm("Really forget this grain?")) {
          Session.set("showMenu", false);
          Meteor.call("deleteRoleAssignments", this.grainId);
          Router.go("root");
        }
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
          // Firefox for some reason decides to kill all websockets when we try to download the file
          // by navigating there. So we're left doing a dirty hack to get around the popup blocker.
          var isFirefox = typeof InstallTrigger !== "undefined";

          if (isFirefox) {
            var save = document.createElement("a");
            save.href = "/downloadBackup/" + id;

            save.download = Session.get("grainFrameTitle") + ".zip";
            var event = document.createEvent("MouseEvents");
            event.initMouseEvent(
                    "click", true, false, window, 0, 0, 0, 0, 0,
                    false, false, false, false, 0, null
            );
            save.dispatchEvent(event);
          } else {
            window.location = "/downloadBackup/" + id;
          }
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
    "submit #newApiToken": function (event) {
      event.preventDefault();
      var grainId = this.grainId;
      Session.set("api-token-" + grainId, "pending");
      var roleList = document.getElementById("api-token-role");
      var assignment;
      if (roleList) {
        assignment = {roleId: roleList.selectedIndex};
      } else {
        assignment = {none: null};
      }
      Meteor.call("newApiToken", this.grainId, document.getElementById("api-token-petname").value,
                  assignment, false,
                  function (error, result) {
        if (error) {
          Session.set("api-token-" + grainId, undefined);
          window.alert("Failed to create token.\n" + error);
          console.error(error.stack);
        } else {
          Session.set("api-token-" + grainId, result.endpointUrl + "#" + result.token);
        }
      });
    },
    "click #resetApiToken": function (event) {
      Session.set("api-token-" + this.grainId, undefined);
    },
    "click button.revoke-token": function (event) {
      ApiTokens.remove(event.currentTarget.getAttribute("data-token-id"));
    },
    "click #show-share-grain": function (event) {
      if (Session.get("show-share-grain")) {
        Session.set("show-share-grain", false);
      } else {
        Session.set("show-share-grain", true);
      }
    },
    "click #share-grain-popup-closer": function (event) {
      Session.set("show-share-grain", false);
    },
    "click #reset-share-token": function (event) {
      Session.set("share-token-" + this.grainId, undefined);
    },
    "submit #new-share-token": function (event) {
      event.preventDefault();
      var grainId = this.grainId;
      Session.set("share-token-" + grainId, "pending");
      var roleList = document.getElementById("share-token-role");
      var assignment;
      if (roleList) {
        assignment = {roleId: roleList.selectedIndex};
      } else {
        assignment = {none: null};
      }
      Meteor.call("newApiToken", grainId, document.getElementById("share-token-petname").value,
                  assignment, true,
                  function (error, result) {
        if (error) {
          console.error(error.stack);
        } else {
          Session.set("share-token-" + grainId, getOrigin() + "/shared/" + result.token);
        }
      });
    },

    "click .token-petname": function (event) {
      // TODO(soon): Find a less-annoying way to get this input, perhaps by allowing the user
      //   to edit the petname in place.
      var petname = window.prompt("Set new label:", this.petname);
      if (petname) {
        ApiTokens.update(event.currentTarget.getAttribute("data-token-id"),
                         {$set: {petname: petname}});
      }
    },

    "click button.revoke-role-assignment": function (event) {
      RoleAssignments.update(event.currentTarget.getAttribute("data-id"),
                            {$set : {active : false}});
    },

    "click button.restore-role-assignment": function (event) {
      RoleAssignments.update(event.currentTarget.getAttribute("data-id"),
                            {$set : {active : true}});
    },

    "click button.show-transitive-shares": function (event) {
      var grainId = this.grainId;
      Meteor.call("transitiveShares", this.grainId, Meteor.userId(), function(error, downstream) {
        if (error) {
          console.error(error.stack);
        } else {
          var shares = [];
          for (var recipient in downstream.users) {
            if (!RoleAssignments.findOne({grainId: grainId, recipient: recipient,
                                          sharer: Meteor.userId(), active: true})) {
              // There is not a direct share from the current user to this recipient.
              shares.push({recipient: recipient, sharers: downstream.users[recipient]});
            }
          }
          if (shares.length == 0) {
            shares = {empty: true};
          }
          Session.set("transitive-shares-" + grainId, shares);
        }
      });
    },

    "click button.hide-transitive-shares": function (event) {
      Session.set("transitive-shares-" + this.grainId, undefined);
    },

    "click #privatize-grain": function (event) {
      Grains.update(this.grainId, {$set: {private: true}});
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
    "click .copy-me": function(event) {
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

  Template.topBar.helpers({
    installPageParams: function() {
      // The https://sandstorm.io/install/ page takes a
      // window.location.hash parameter. This code assumes that the
      // install link only shows up if this is a demo user. Therefore,
      // for our purposes, it should contain:
      //
      // - The current app title, if we can determine it, or
      //
      // - The string "demo", if we can't determine the current app
      //   title.
      var params = "demo";

      if (! this.grainId) {
        return params;
      }

      var thisPackageId = Grains.findOne(
        {_id: this.grainId}).packageId;

      // If we don't seem to find the package, then bail out now.
      if (! thisPackageId) {
        return params;
      }

      var thisPackage = Packages.findOne({_id: thisPackageId});

      if (thisPackage) {
        params = appNameFromPackage(thisPackage);
      }

      return params;
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

    dateString: function (date) { return makeDateString(date); },

    setGrainWindowTitle:  function() {
      var appTitle = Session.get("grainFrameTitle");
      if (appTitle) {
        document.title = appTitle + " · " + this.title + " · Sandstorm";
      } else {
        document.title = this.title + " · Sandstorm";
      }
    },

    userId: function () {
      return Meteor.userId();
    },

    displayName: function (userId) {
      var name = DisplayNames.findOne(userId);
      if (name) {
        return name.displayName;
      } else if (userId === Meteor.userId()) {
        return Meteor.user().profile.name + " (you)";
      } else {
        return "Unknown User (" + userId + ")";
      }
    },
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
      } else if (event.data.setTitle) {
        Session.set("grainFrameTitle", event.data.setTitle);
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

function grainRouteHelper(route, result, openSessionMethod, openSessionArg, rootPath) {
  var grainId = result.grainId;

  var apiToken = Session.get("api-token-" + grainId);
  var shareToken = Session.get("share-token-" + grainId);

  result.apiToken = apiToken;
  result.apiTokenPending = apiToken === "pending",
  result.showApiToken = Session.get("show-api-token"),
  result.existingTokens = ApiTokens.find({grainId: grainId, userId: Meteor.userId(),
                                          forSharing: {$ne: true}}).fetch(),
  result.shareToken = shareToken,
  result.shareTokenPending = shareToken === "pending",
  result.showShareGrain = Session.get("show-share-grain"),
  result.existingShareTokens = ApiTokens.find({grainId: grainId, userId: Meteor.userId(),
                                               forSharing: true}).fetch(),
  result.existingAssignments = RoleAssignments.find({grainId: grainId,
                                                     sharer : Meteor.userId()}).fetch(),
  result.transitiveShares = Session.get("transitive-shares-" + grainId);
  result.showMenu = Session.get("showMenu");

  var err = route.state.get("error");
  if (err) {
    result.error = err;
    return result;
  }

  var session = Sessions.findOne({grainId: grainId});
  if (session) {
    route.state.set("openingSession", undefined);
    result.appOrigin = window.location.protocol + "//" + makeWildcardHost(session.hostId);
    setCurrentSessionId(session._id, result.appOrigin, grainId);
    result.sessionId = session._id;
    result.viewInfo = session.viewInfo;
    var currentPath = window.location.pathname + window.location.search;
    var grainPath = currentPath.slice(rootPath.length);
    result.path = encodeURIComponent(grainPath);
    result.hash = window.location.hash || "";
    return result;
  } else if (route.state.get("openingSession")) {
    return result;
  } else {
    route.state.set("openingSession", true);
    Meteor.call(openSessionMethod, openSessionArg, function (error, result) {
      if (error) {
        route.state.set("error", error.message);
        route.state.set("openingSession", undefined);
      } else if (result.redirect) {
        return Router.go(result.redirect);
      } else {
        route.state.set("title", result.title);
        route.state.set("grainId", result.grainId);
        var subscription = Meteor.subscribe("sessions", result.sessionId);
        Sessions.find({_id : result.sessionId}).observeChanges({
          removed: function(session) {
            subscription.stop();
          },
          added: function(session) {
            route.state.set("openingSession", undefined);
          }
        });
      }
    });
    return result;
  }
}

GrainLog = new Mongo.Collection("grainLog");
// Pseudo-collection created by subscribing to "grainLog", implemented in proxy.js.

Router.map(function () {
  this.route("grain", {
    path: "/grain/:grainId/:path(.*)?",

    waitOn: function () {
      // All grains need this information.
      var subscriptions = [
        Meteor.subscribe("grainTopBar", this.params.grainId),
        Meteor.subscribe("devApps"),
      ];

      // Grains on the demo server need the app title in order to
      // customize the link to https://sandstorm.io/install/#appTitle.
      if (Meteor.settings && Meteor.settings.public &&
          Meteor.settings.public.allowDemoAccounts) {
        subscriptions.push(
          Meteor.subscribe("packageByGrainId", this.params.grainId));
      }

      return subscriptions;
    },

    data: function () {
      // Make sure that if any dev apps are published or removed, we refresh the grain view.
      setCurrentSessionId(undefined, undefined, undefined);
      var grainId = this.params.grainId;
      var title;
      var grain = Grains.findOne(grainId);
      if (grain) {
        title = grain.title;
      } else {
        var roleAssignment = RoleAssignments.findOne({grainId: grainId, recipient: Meteor.userId()},
                                                     {sort:{created:1}});
        if (roleAssignment) {
          title = roleAssignment.title;
        }
      }
      return grainRouteHelper(this,
                              {grainId: grainId, title: title,
                               isOwner: grain && grain.userId && grain.userId === Meteor.userId(),
                               isDemoUser: isDemoUser(),
                               oldSharingModel: grain && !grain.private},
                               "openSession", grainId,
                               "/grain/" + grainId);

    },

    onStop: function () {
      setCurrentSessionId(undefined, undefined, undefined);
      Session.set("grainFrameTitle", undefined);
      document.title = DEFAULT_TITLE;
      unblockUpdate();
    }
  });

  this.route("/shared/:key", {
    template: "grain",

    waitOn: function () {
      return [
        Meteor.subscribe("devApps"),
      ];
    },

    data: function() {
      if (this.state.get("grainId")) {
        Session.set("api-token-" + this.state.get("grainId"),
                    window.location.protocol + "//" + makeWildcardHost("api") + "#"
                    + this.params.key);
      }
      return grainRouteHelper(this,
                              {grainId: this.state.get("grainId"), title: this.state.get("title")},
                              "openSessionFromApiToken", this.params.key,
                              "/shared/" + this.params.key);
    },

    onStop: function () {
      setCurrentSessionId(undefined, undefined, undefined);
      Session.set("grainFrameTitle", undefined);
      document.title = DEFAULT_TITLE;
      unblockUpdate();
    }
  });

  this.route("grainLog", {
    path: "/grainlog/:grainId",
    layoutTemplate: "lightLayout",

    waitOn: function () {
      return [
        Meteor.subscribe("grainTopBar", this.params.grainId),
        Meteor.subscribe("grainLog", this.params.grainId)
      ];
    },

    data: function () {
      if (this.ready()) {
        maybeScrollLog();
        var grain = Grains.findOne(this.params.grainId);
        return {
          title: grain ? grain.title : "(deleted grain)",
          html: AnsiUp.ansi_to_html(GrainLog.find({}, {$sort: {_id: 1}})
              .map(function (entry) { return entry.text; })
              .join(""), {use_classes:true})
        };
      }
    }
  });
});

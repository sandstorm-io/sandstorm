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
  var Crypto = Npm.require("crypto");

  Meteor.publish("grainTopBar", function (grainId) {
    check(grainId, String);
    var self = this;

    // Alice is allowed to know Bob's display name if Bob has received a UiView from Alice
    // for *any* grain.
    var handle = ApiTokens.find({userId: this.userId,
                                 "owner.user.userId": {$exists: true}}).observe({
      added: function(token) {
        var user = Meteor.users.findOne(token.owner.user.userId);
        if (user) {
          self.added("displayNames", user._id, {displayName: user.profile.name});
        }
      },
    });
    this.onStop(function() { handle.stop(); });

    return [Grains.find({_id : grainId, $or: [{userId: this.userId}, {private: {$ne: true}}]},
                        {fields: {title: 1, userId: 1, private: 1}}),
            ApiTokens.find({grainId: grainId,
                            $or : [{"owner.user.userId": this.userId}, {userId: this.userId}]}),
           ];
  });

  // We allow users to learn package information about a grain they own.
  // This is used for obtaining icon and app title information for grains
  // you own, which is used in the sidebar. It is not a security/privacy
  // risk since it only exposes this information for grains the user owns.
  Meteor.publish("packageByGrainId", function (grainId) {
    check(grainId, String);
    var publishThis = [];
    // We need to publish the packageId so that client-side code can
    // find the right package.
    var thisGrainCursor = Grains.find({_id: grainId, userId: this.userId},
                                      {fields: {packageId: 1}});
    publishThis.push(thisGrainCursor);

    if (thisGrainCursor.count()) {
      var thisGrain = thisGrainCursor.fetch()[0];
      var thisPackageCursor = Packages.find({_id: thisGrain.packageId});
      publishThis.push(thisPackageCursor);
    }

    return publishThis;
  });


  Meteor.publish("tokenInfo", function (token) {
    // Allows the client side to map a raw token to its entry in ApiTokens, and the additional
    // metadata that it will need to display the app icon and title.  We do not care about making
    // the metadata reactive.
    check(token, String);

    var hashedToken = Crypto.createHash("sha256").update(token).digest("base64");
    var apiToken = ApiTokens.findOne({_id: hashedToken}, {fields: {grainId: 1, userId: 1}});
    if (!apiToken || (apiToken.owner && !("webkey" in apiToken.owner))) {
      this.added("tokenInfo", token, {invalidToken: true});
    } else {
      var grainId = apiToken.grainId;
      var grain = Grains.findOne({_id: grainId}, {fields: {packageId: 1, appId: 1}});
      var pkg = Packages.findOne({_id: grain.packageId}, {fields: {manifest: 1}});
      var appTitle = (pkg && pkg.manifest && pkg.manifest.appTitle) || { defaultText: ""};
      var appIcon = undefined;
      if (pkg && pkg.manifest && pkg.manifest.metadata && pkg.manifest.metadata.icons) {
        var icons = pkg.manifest.metadata.icons;
        appIcon = icons.grain || icons.appGrid;
      }
      var denormalizedGrainMetadata = {
        appTitle: appTitle,
        icon: appIcon,
        appId: appIcon ? undefined : grain.appId,
      };
      this.added("tokenInfo", token, {apiToken: apiToken, grainMetadata: denormalizedGrainMetadata});
    }
    this.ready();
    return;
  });

  Meteor.publish("grainSize", function (sessionId) {
    // Publish pseudo-collection containing the size of the grain opened in the given session.
    check(sessionId, String);

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
          if (err.kjType === "disconnected") {
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
        if (err.kjType === "disconnected") {
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
}

// GrainSizes is used by grainview.js
GrainSizes = new Mongo.Collection("grainSizes");
var DisplayNames = new Mongo.Collection("displayNames");
// TokenInfo is used by grainview.js
TokenInfo = new Mongo.Collection("tokenInfo");
// Pseudo-collections published above.

Meteor.methods({
  deleteGrain: function (grainId) {
    check(grainId, String);

    if (this.userId) {
      var grain = Grains.findOne({_id: grainId, userId: this.userId});
      if (grain) {
        Grains.remove(grainId);
        ApiTokens.remove({grainId : grainId, $or: [{owner: {$exists: false}},
                                                   {owner: {webkey: null}}]});
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
  forgetGrain: function (grainId) {
    check(grainId, String);

    if (this.userId) {
      ApiTokens.remove({grainId: grainId, "owner.user.userId": this.userId});
    }
  },
  updateGrainTitle: function (grainId, newTitle) {
    check(grainId, String);
    check(newTitle, String);
    if (this.userId) {
      var grain = Grains.findOne(grainId);
      if (grain) {
        if (this.userId === grain.userId) {
          Grains.update(grainId, {$set: {title: newTitle}});
        } else {
          var token = ApiTokens.findOne({grainId: grainId, objectId: {$exists: false},
                                         "owner.user.userId": this.userId},
                                        {sort:{created:1}});
          if (token) {
            ApiTokens.update(token._id, {$set: {"owner.user.title": newTitle}});
          }
        }
      }
    }
  },
  privatizeGrain: function (grainId) {
    check(grainId, String);
    if (this.userId) {
      Grains.update({_id: grainId, userId: this.userId}, {$set: {private: true}});
    }
  },
  inviteUsersToGrain: function (origin, grainId, title, roleAssignment, emailAddresses, message) {
    if (!this.isSimulation) {
      check(origin, String);
      check(grainId, String);
      check(title, String);
      check(roleAssignment, roleAssignmentPattern);
      check(emailAddresses, [String]);
      check(message, {text: String, html: String});
      var userId = this.userId;
      if (!userId) {
        throw new Meteor.Error(403, "Must be logged in to share by email.");
      }
      var sharerDisplayName = Meteor.user().profile.name;
      var outerResult = {successes: [], failures: []};
      emailAddresses.forEach(function(emailAddress) {
        var result = createNewApiToken(userId, grainId,
                                       "email invitation for " + emailAddress,
                                       roleAssignment,
                                       true, undefined);
        var url = origin + "/shared/" + result.token;
        var html = message.html + "<br><br>" +
            "<a href='" + url + "' style='display:inline-block;text-decoration:none;" +
            "font-family:sans-serif;width:200px;min-height:30px;line-height:30px;" +
            "border-radius:4px;text-align:center;background:#428bca;color:white'>" +
            "Open Shared Grain</a><div style='font-size:8pt;font-style:italic;color:gray'>" +
            "Note: If you forward this email to other people, they will be able to access " +
            "the share as well. To prevent this, remove the button before forwarding.</div>";
        try {
          SandstormEmail.send({
            to: emailAddress,
            from: "Sandstorm server <no-reply@" + HOSTNAME + ">",
            subject: sharerDisplayName + " has invited you to join a grain: " + title,
            text: message.text + "\n\nFollow this link to open the shared grain:\n\n" + url +
              "\n\nNote: If you forward this email to other people, they will be able to access " +
              "the share as well. To prevent this, remove the link before forwarding.",
            html: html,
          });
          outerResult.successes.push(emailAddress);
        } catch (e) {
          outerResult.failures.push({email: emailAddress, error: e.toString()});
        }
      });
      return outerResult;
    }
  },
});

if (Meteor.isClient) {
  Tracker.autorun(function() {
    // We need to keep track of certain data about each grain we can view
    var grains = globalGrains.get();
    grains.forEach(function(grain) {
      grain.depend();
      var grainId = grain.grainId();
      if (grainId) {
        Meteor.subscribe("grainTopBar", grainId);
        if (grain.isOwner()) {
          Meteor.subscribe("packageByGrainId", grainId);
          var session = Sessions.findOne({grainId: grainId});
          if (session) {
            Meteor.subscribe("grainSize", session._id);
          }
        }
        var token = grain.token();
        if (token) {
          Meteor.subscribe("tokenInfo", token);
        }
      }
    });
  })

  Template.layout.events({
    "click .incognito-button": function (event) {
      console.log("incognito button clicked");
      console.log(event);
      var grains = globalGrains.get();
      var token = event.currentTarget.getAttribute("data-token");
      if (token) {
        grains.forEach(function (grain) {
          if (grain.token() == token) {
            grain.setRevealIdentity(false);
          }
        });
      } else {
        console.error("Interstitial prompt answered, but no token present?");
      }
    },

    "click .redeem-token-button": function (event) {
      console.log("redeem button clicked");
      console.log(event);
      var grains = globalGrains.get();
      var token = event.currentTarget.getAttribute("data-token");
      if (token) {
        grains.forEach(function (grain) {
          if (grain.token() == token) {
            grain.setRevealIdentity(true);
          }
        });
      } else {
        console.error("Interstitial prompt answered, but no token present?");
      }
    },
  });

  Template.grainTitle.events({
    "click": function (event) {
      var grain = getActiveGrain(globalGrains.get());
      if (grain) {
        var prompt = "Set new title:";
        if (!grain.isOwner()) {
          prompt = "Set a new personal title: (does not change the owner's title for this grain)";
        }
        var title = window.prompt(prompt, grain.title());
        if (title) {
          grain.setTitle(title);
        }
      }
    },
  });

  Template.grainDeleteButton.events({
    "click button": function (event) {
      var grains = globalGrains.get();
      var activeIndex = activeGrainIndex(grains);
      var activeGrain = grains[activeIndex];
      var newActiveIndex = (activeIndex == grains.length - 1) ? activeIndex - 1 : activeIndex;
      if (activeGrain.isOwner()) {
        if (window.confirm("Really delete this grain?")) {
          Meteor.call("deleteGrain", activeGrain.grainId());
          // TODO: extract globalGrains into a class that has a "close" method for closing the active view
          activeGrain.destroy();
          if (grains.length == 1) {
            globalGrains.set([]);
            Router.go("root");  // will redirect to the right place
          } else {
            grains.splice(activeIndex, 1);
            grains[newActiveIndex].setActive(true);
            globalGrains.set(grains);
            Router.go("grain", {grainId: grains[newActiveIndex].grainId()});
          }
        }
      } else {
        if (window.confirm("Really forget this grain?")) {
          Meteor.call("forgetGrain", activeGrain.grainId());
          // TODO: extract globalGrains into a class that has a "close" method for closing the active view
          activeGrain.destroy();
          if (grains.length == 1) {
            globalGrains.set([]);
            Router.go("root");  // will redirect to the right place
          } else {
            grains.splice(activeIndex, 1);
            grains[newActiveIndex].setActive(true);
            globalGrains.set(grains);
            Router.go("grain", {grainId: grains[newActiveIndex].grainId()});
          }
        }
      }
    },
  });

  Template.grainDebugLogButton.events({
    "click button": function (event) {
      this.reset();
      var activeGrain = getActiveGrain(globalGrains.get());
      window.open("/grainlog/" + activeGrain.grainId(), "_blank",
          "menubar=no,status=no,toolbar=no,width=700,height=700");
    },
  });

  Template.grainBackupButton.events({
    "click button": function (event) {
      this.reset();
      var activeGrain = getActiveGrain(globalGrains.get());
      Meteor.call("backupGrain", activeGrain.grainId(), function (err, id) {
        if (err) {
          alert("Backup failed: " + err); // TODO(someday): make this better UI
        } else {
          // Firefox for some reason decides to kill all websockets when we try to download the file
          // by navigating there. So we're left doing a dirty hack to get around the popup blocker.
          var isFirefox = typeof InstallTrigger !== "undefined";

          if (isFirefox) {
            var save = document.createElement("a");
            save.href = "/downloadBackup/" + id;

            save.download = activeGrain.title() + ".zip";
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
  });

  Template.grainRestartButton.events({
    "click button": function (event) {
      this.reset();
      var activeGrain = getActiveGrain(globalGrains.get());
      var grainId = activeGrain.grainId();

      Meteor.call("shutdownGrain", grainId, function (err) {
        if (err) {
          alert("Restart failed: " + err); // TODO(someday): make this better UI
        } else {
          var frames = document.getElementsByClassName("grain-frame");
          for (var i = 0 ; i < frames.length ; i++) {
            var frame = frames[i];
            if (frame.dataset.grainid == grainId) {
              frame.src = frame.src;
            }
          }
        }
      });
    },
  });

  function copyMe(event) {
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

  Template.grainApiTokenPopup.events({
    "click .copy-me": copyMe,
    "submit .newApiToken": function (event) {
      event.preventDefault();
      var activeGrain = getActiveGrain(globalGrains.get());
      var grainId = activeGrain.grainId();
      activeGrain.setGeneratedApiToken("pending");
      var roleList = document.getElementById("api-token-role");
      // TODO(cleanup): avoid using global ids; select a child of the current template instead
      var assignment = {allAccess: null};
      if (roleList && roleList.selectedIndex > 0) {
        assignment = {roleId: roleList.selectedIndex - 1};
      }
      Meteor.call("newApiToken", grainId, document.getElementById("api-token-petname").value,
                  assignment, false, undefined,
                  function (error, result) {
        if (error) {
          activeGrain.setGeneratedApiToken(undefined);
          window.alert("Failed to create token.\n" + error);
          console.error(error.stack);
        } else {
          activeGrain.setGeneratedApiToken(result.endpointUrl + "#" + result.token);
        }
      });
    },
    "click #resetApiToken": function (event) {
      var activeGrain = getActiveGrain(globalGrains.get());
      activeGrain.setGeneratedApiToken(undefined);
    },
    "click button.revoke-token": function (event) {
      Meteor.call("updateApiToken", event.currentTarget.getAttribute("data-token-id"),
                  {revoked: true});
    },

    "click .token-petname": function (event) {
      // TODO(soon): Find a less-annoying way to get this input, perhaps by allowing the user
      //   to edit the petname in place.
      var petname = window.prompt("Set new label:", this.petname);
      if (petname) {
        Meteor.call("updateApiToken", event.currentTarget.getAttribute("data-token-id"),
                    {petname: petname});
      }
    },
  });

  Template.grainSharePopup.events({
    "click .copy-me": copyMe,
    "click #share-grain-popup-closer": function (event) {
      Session.set("show-share-grain", false);
    },
    "click button.who-has-access": function (event, instance) {
      event.preventDefault();
      var closer = globalTopbar.addItem({
        name: "who-has-access",
        template: Template.whoHasAccess,
        popupTemplate: Template.whoHasAccessPopup,
        data: new ReactiveVar(instance.data),
        startOpen: true,
        onDismiss: function () {
          return "remove";
        }
      });
    },
    "click #privatize-grain": function (event) {
      Meteor.call("privatizeGrain", getActiveGrain(globalGrains.get()).grainId());
    },
  });

  Template.shareWithOthers.events({
    "click .sharable-link": function (event, instance) {
      instance.find(".share-tabs").setAttribute("data-which-tab", "sharable-link");
    },
    "click .send-invite": function (event, instance) {
      instance.find(".share-tabs").setAttribute("data-which-tab", "send-invite");
    },
  });

  Template.sharableLinkTab.events({
    "change .share-token-role": function (event, instance) {
      var success = instance.completionState.get().success;
      if (success) {
        var roleList = event.target;
        var assignment;
        if (roleList) {
          assignment = {roleId: roleList.selectedIndex};
        } else {
          assignment = {none: null};
        }
        Meteor.call("updateApiToken", success.id, {roleAssignment: assignment}, function (error) {
          if (error) {
            console.error(error.stack);
          }
        });
      }
    },
    "change .label": function (event, instance) {
      var success = instance.completionState.get().success;
      if (success) {
        var label = event.target.value;
        Meteor.call("updateApiToken", success.id, {petname: label}, function (error) {
          if (error) {
            console.error(error.stack);
          }
        });
      }
    },
    "submit form.new-share-token": function (event, instance) {
      event.preventDefault();
      if (!instance.completionState.get().clear) {
        return;
      }
      var currentGrain = getActiveGrain(globalGrains.get());
      var grainId = currentGrain.grainId();
      var roleList = event.target.getElementsByClassName("share-token-role")[0];
      var assignment;
      if (roleList) {
        assignment = {roleId: roleList.selectedIndex};
      } else {
        assignment = {none: null};
      }
      instance.completionState.set({"pending": true});
      Meteor.call("newApiToken", grainId, event.target.getElementsByClassName("label")[0].value,
                  assignment, true, undefined,
                  function (error, result) {
        if (error) {
          console.error(error.stack);
        } else {
          result.url = getOrigin() + "/shared/" + result.token;
          instance.completionState.set({"success": result});
        }
      });
    },
    "click .reset-share-token": function (event, instance) {
      instance.completionState.set({clear: true});
      instance.find("form").reset();
      instance.find("form option[data-default-selected=true]").selected = true;
    },
  });

  Template.grainPowerboxRequestPopup.events({
    "submit #powerbox-request-form": function (event) {
      event.preventDefault();
      var powerboxRequestInfo = this;
      Meteor.call("finishPowerboxRequest", event.target.token.value, powerboxRequestInfo.saveLabel,
        powerboxRequestInfo.grainId,
        function (err, token) {
          if (err) {
            powerboxRequestInfo.error.set(err.toString());
          } else {
            powerboxRequestInfo.source.postMessage(
              {
                rpcId: powerboxRequestInfo.rpcId,
                token: token
              }, powerboxRequestInfo.origin);
            powerboxRequestInfo.closer.close();
          }
        }
      );
    }
  });

  Template.grainPowerboxOfferPopup.events({
    "click button.dismiss": function (event) {
      var sessionId = Template.instance().data.sessionId;
      if (sessionId) {
        Meteor.call("finishPowerboxOffer", sessionId, function (err) {
          // TODO(someday): display the error nicely to the user
          if (err) {
            console.error(err);
          }
        });
      } else {
        // TODO(cleanup): This path is used by the admin UI. This is really hacky, though.
        Iron.controller().state.set("powerboxOfferUrl", null);
      }
    },
    "click .copy-me": copyMe
  });

  Template.grainSharePopup.helpers({
    "currentGrain": function() {
      return getActiveGrain(globalGrains.get());
    }
  });

  Template.grain.onCreated(function () {
    this.originalPath = window.location.pathname + window.location.search;
    this.originalHash = window.location.hash;
  });

  Template.grainView.helpers({
    unpackedGrainState: function () {
      return mapGrainStateToTemplateData(this);
    }
  });

  Template.grain.helpers({
    currentGrain: function () {
      return getActiveGrain(globalGrains.get());
    },
    isOwner: function () {
      var current = getActiveGrain(globalGrains.get());
      return current && current.isOwner();
    },

    grainSize: function () {
      var current = getActiveGrain(globalGrains.get());
      var sizeBytes = current && current.size();
      if (sizeBytes !== undefined) {
        return "(" + prettySize(sizeBytes) + ")";
      } else {
        return "";
      }
    },

    setGrainWindowTitle:  function() {
      var current = getActiveGrain(globalGrains.get());
      if (current) {
        current.updateDocumentTitle();
      }
    },

    displayWebkeyButton: function () {
      // TODO: figure out what this should do
      return Meteor.userId() || !this.oldSharingModel;
    },

    showPowerboxOffer: function () {
      var current = getActiveGrain(globalGrains.get());
      if (current) {
        var session = Sessions.findOne({_id: current.sessionId()}, {fields: {powerboxView: 1}});
        return session && session.powerboxView && !!session.powerboxView.offer;
      }
      return false;
    },
  });

  Template.grainTitle.helpers({
    title: function () {
      var grain = getActiveGrain(globalGrains.get());
      return (grain && grain.title()) || "Untitled grain";
    }
  });

  Template.grainApiTokenPopup.helpers({
    displayToken: function() {
      return !this.revoked && !this.expiresIfUnused && !this.parentToken;
    },
    existingTokens: function () {
      var current = getActiveGrain(globalGrains.get());
      return current && ApiTokens.find({grainId: current.grainId(), userId: Meteor.userId(),
                                        forSharing: {$ne: true},
                                        $or: [{owner: {webkey: null}},
                                              {owner: {$exists: false}}],
                                        expiresIfUnused: null});
    },
    generatedApiToken: function () {
      var current = getActiveGrain(globalGrains.get());
      return current && current.generatedApiToken();
    },
    generatedApiTokenPending: function() {
      var current = getActiveGrain(globalGrains.get());
      return (current && current.generatedApiToken()) == "pending";
    },
    viewInfo: function () {
      var current = getActiveGrain(globalGrains.get());
      return current && current.viewInfo();
    }
  });

  Template.whoHasAccessPopup.onCreated(function () {
    var instance = this;
    var currentGrain = getActiveGrain(globalGrains.get());
    instance.grainId = currentGrain.grainId();
    instance.transitiveShares = new ReactiveVar(null);
    this.resetTransitiveShares = function() {
      Meteor.call("transitiveShares", instance.grainId, function(error, downstream) {
        if (error) {
          console.error(error.stack);
        } else {
          var sharesByRecipient = {};
          downstream.forEach(function (token) {
            if (Match.test(token.owner, {user: Match.ObjectIncluding({userId: String})})) {
              var recipient = token.owner.user.userId;
              if (!sharesByRecipient[recipient]) {
                sharesByRecipient[recipient] = {recipient: recipient, shares: []};
              }
              var shares = sharesByRecipient[recipient].shares;
              if (!shares.some(function(share) { return share.userId === token.userId; })) {
                sharesByRecipient[recipient].shares.push(token);
              }
            }
          });
          var result = _.values(sharesByRecipient);
          if (result.length == 0) {
            result = {empty: true};
          }
          instance.transitiveShares.set(result);
        }
      });
    }
    this.resetTransitiveShares();
  });

  Template.whoHasAccessPopup.events({
    "change .share-token-role": function (event, instance) {
      var roleList = event.target;
      var assignment;
      if (roleList) {
        assignment = {roleId: roleList.selectedIndex};
      } else {
        assignment = {none: null};
      }
      Meteor.call("updateApiToken", roleList.getAttribute("data-token-id"),
                  {roleAssignment: assignment}, function (error) {
        if (error) {
          console.error(error.stack);
        }
      });
    },
    "click button.revoke-token": function (event, instance) {
      Meteor.call("updateApiToken", event.currentTarget.getAttribute("data-token-id"),
                  {revoked: true});
      instance.resetTransitiveShares();
    },
    "click .token-petname": function (event) {
      // TODO(soon): Find a less-annoying way to get this input, perhaps by allowing the user
      //   to edit the petname in place.
      var petname = window.prompt("Set new label:", this.petname);
      if (petname) {
        Meteor.call("updateApiToken", event.currentTarget.getAttribute("data-token-id"),
                    {petname: petname});
      }
    },
  });

  function isEmptyPermissionSet(permissionSet) {
    if (!permissionSet) {
      return true;
    }
    for (var ii = 0; ii < permissionSet.length; ++ii) {
      if (permissionSet[ii]) {
        return false;
      }
    }
    return true;
  }

  Template.whoHasAccessPopup.helpers({
    existingShareTokens: function () {
      return ApiTokens.find({grainId: Template.instance().grainId, userId: Meteor.userId(),
                             forSharing: true,
                             $or: [{owner: {webkey:null}},
                                   {owner: {$exists: false}}],
                            }).fetch();
    },
    getPetname: function () {
      if (this.petname) {
        return this.petname;
      } else {
        return "Unlabeled Link";
      }
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
    transitiveShares: function () {
      return Template.instance().transitiveShares.get();
    },
    indexedRoles: function () {
      var result = [];
      var instance = Template.instance();
      var currentGrain = getActiveGrain(globalGrains.get());
      var roles = currentGrain.viewInfo().roles;
      for (var ii = 0; ii < roles.length; ++ii) {
        result.push({idx: ii, title: roles[ii].title, verbPhrase: roles[ii].verbPhrase});
      }
      return result;
    },
    roleText: function () {
      if (this.verbPhrase) {
        return this.verbPhrase.defaultText;
      } else {
        return "is " + this.title.defaultText;
      }
    },
    hasCustomRole: function(token) {
      var role = token.roleAssignment;
      if ("roleId" in role &&
          isEmptyPermissionSet(role.addPermissions) &&
          isEmptyPermissionSet(role.removePermissions)) {
        return false;
      }
      return true;
    },
    hasCurrentRole: function(token) {
      var role = token.roleAssignment;
      if ("roleId" in role && role.roleId == this.idx &&
          isEmptyPermissionSet(role.addPermissions) &&
          isEmptyPermissionSet(role.removePermissions)) {
        return true;
      }
      return false;
    },
    displayToken: function() {
      return !this.revoked && !this.expiresIfUnused && !this.parentToken;
    },
    viewInfo: function() {
      var activeGrain = getActiveGrain(globalGrains.get());
      return activeGrain && activeGrain.viewInfo();
    },
  });

  Template.selectRole.helpers({
    roleText: function () {
      if (this.verbPhrase) {
        return this.verbPhrase.defaultText;
      } else {
        return "is " + this.title.defaultText;
      }
    },
  });

  Template.sharableLinkTab.onCreated(function () {
    this.completionState = new ReactiveVar({clear: true});
  });

  Template.emailInviteTab.onCreated(function () {
    this.completionState = new ReactiveVar({clear: true});
  });

  Template.sharableLinkTab.helpers({
    completionState: function() {
      var instance = Template.instance();
      return instance.completionState.get();
    }
  });
  Template.emailInviteTab.helpers({
    completionState: function() {
      var instance = Template.instance();
      return instance.completionState.get();
    },
  });

  Template.emailInviteTab.events({
    "submit form.email-invite": function (event, instance) {
      event.preventDefault();
      if (!instance.completionState.get().clear) {
        return;
      }
      var grainId = instance.data.grainId;
      var title = instance.data.title;

      // MailComposer accepts a comma-delimited list, but we want to split the list before
      // sending the mail because we want a separate token for each user. Moreover, users
      // will probably expect space-delimited lists to work, and when we eventually implement
      // autocompletion and inline validation, we expect that we will display a space-delimited
      // list. So we split on spaces here and allow MailComposer to clean up any stray commas.
      var emails = event.target.getElementsByClassName("emails")[0].value.split(" ");
      emails = emails.filter(function (email) { return email.length > 0;});
      if (emails.length == 0) {
        return;
      }
      var roleList = event.target.getElementsByClassName("share-token-role")[0];
      var assignment;
      if (roleList) {
        assignment = {roleId: roleList.selectedIndex};
      } else {
        assignment = {none: null};
      }
      var message = event.target.getElementsByClassName("personal-message")[0].value;
      instance.completionState.set({pending: true});

      // HTML-escape the message.
      var div = document.createElement('div');
      div.appendChild(document.createTextNode(message));
      var htmlMessage = div.innerHTML.replace(/\n/g, "<br>");

      Meteor.call("inviteUsersToGrain", getOrigin(), grainId, title, assignment, emails,
                  {text: message, html: htmlMessage}, function (error, result) {
        if (error) {
          instance.completionState.set({error: error.toString()});
        } else {
          if (result.failures.length > 0) {
            var message = "Failed to send to: ";
            for (var ii = 0; ii < result.failures.length; ++ii) {
              if (ii != 0) {
                message += ", ";
              }
              message += result.failures[ii].email;
            }
            instance.completionState.set({error: message});
          } else {
            instance.completionState.set({success: "success"});
          }
        }
      });
    },
    "click .reset-invite": function (event, instance) {
      instance.completionState.set({clear: true});
      instance.find("form").reset();
      instance.find("form option[data-default-selected=true]").selected = true;
    },
  });

  Template.grainPowerboxOfferPopup.helpers({
    powerboxOfferUrl: function () {
      if (this.powerboxOfferUrl) {
        // TODO(cleanup): This path is used by the admin UI. This is really hacky, though.
        return this.powerboxOfferUrl;
      }

      var activeGrain = getActiveGrain(globalGrains.get());
      var session = Sessions.findOne({_id: activeGrain.sessionId()}, {fields: {powerboxView: 1}});
      return session && session.powerboxView && session.powerboxView.offer;
    },
  });

  // Send a keep-alive for each grain every now and then.
  Meteor.setInterval(function () {
    var grains = globalGrains.get();
    if (!grains) return;
    grains.forEach(function (grain) {
      if (grain.sessionId()) {
        // TODO(soon):  Investigate what happens in background tabs.  Maybe arrange to re-open the
        //   app if it dies while in the background.
        console.log("keepalive: ", new Date());
        Meteor.call("keepSessionAlive", grain.sessionId(), function (error, result) {
          if (!result) {
            // TODO(soon):  Make a UI for this.
            //   Hmm... Actually this may not be a real problem since the grain will be restarted
            //   on the next request. The only real problem is if the proxy has been removed on the
            //   server side, so perhaps check for that.
            console.error("Session seems to have died.  Please reload to fix.");
          }
        });
      }
    });
  }, 60000);

  // Message handler for Sandstorm's client-side postMessage API.
  Meteor.startup(function () {
    var messageListener = function (event) {
      if (event.origin === getOrigin()) {
        // Meteor likes to postMessage() to itself sometimes, so we ignore these messages.
        return;
      }

      // Look up the grain index of which grain this postmessage came from, so we can map behavior
      // into that particular grain's state
      var grains = globalGrains.get();
      var senderGrainIndex = grainOriginToIndex(grains, event.origin);
      if (senderGrainIndex == -1) {
        // We got a postMessage from an origin that is not a grain we currently believe is open.
        // Ignore it. (It may be aimed at some other message listener registered elsewhere...)
        return;
      }
      var senderGrain = grains[senderGrainIndex];

      if (event.data.setPath) {
        var path = event.data.setPath;
        check(path, String);
        check(path.charAt(0), '/');
        // TODO(security): More sanitization of this path. E.g. reject "/../../".
        senderGrain.setPath(path);
      } else if (event.data.setTitle) {
        senderGrain.setFrameTitle(event.data.setTitle);
      } else if (event.data.renderTemplate) {
        // Request creation of a single-use template with a privileged API token.
        // Why?  Apps should not be able to obtain capabilities-as-keys to
        // themselves directly, because those can be leaked through an
        // arbitrary bit stream or covert channel.  However, apps often need a
        // way to provide instructions to users to copy/paste with some
        // privileged token contained within.  By providing this templating in
        // the platform, we can ensure that the token is only visible to the
        // shell's origin.
        var call = event.data.renderTemplate;
        check(call, Object);
        var rpcId = call.rpcId;
        try {
          check(call, {rpcId: String, template: String, petname: Match.Optional(String),
                       roleAssignment: Match.Optional(roleAssignmentPattern),
                       forSharing: Match.Optional(Boolean)});
        } catch (error) {
          event.source.postMessage({rpcId: rpcId, error: error.toString()}, event.origin);
          return;
        }
        var template = call.template;
        var petname = "connected external app";
        if (call.petname) {
          petname = call.petname;
        }
        var assignment = {allAccess: null};
        if (call.roleAssignment) {
          assignment = call.roleAssignment;
        }
        var forSharing = call.forSharing ? call.forSharing : false;
        // Tokens expire by default in 5 minutes from generation date
        var selfDestructDuration = 5 * 60 * 1000;

        var rawParentToken;
        if (Router.current().route.getName() === "shared") {
          rawParentToken = Router.current().params.token;
        }
        Meteor.call("newApiToken", senderGrain.grainId(), petname, assignment, forSharing,
                    selfDestructDuration, rawParentToken, function (error, result) {
          if (error) {
            event.source.postMessage({rpcId: rpcId, error: error.toString()}, event.origin);
          } else {
            var tokenId = result.token;
            // Generate random key id2.
            var id2 = Random.secret();
            // Store apitoken id1 and template in session storage in the offer
            // template namespace under key id2.
            var key = "offerTemplate" + id2;
            var renderedTemplate = template.replace(/\$API_TOKEN/g, tokenId)
                                           .replace(/\$API_HOST/g, makeWildcardHost("api"));
            sessionStorage.setItem(key, JSON.stringify({
                "token": tokenId,
                "renderedTemplate": renderedTemplate,
                "expires": Date.now() + selfDestructDuration
              })
            );
            sessionStorage.setItem("apiHost", makeWildcardHost("api"));

            // Send message to event.source with URL containing id2
            templateLink = window.location.origin + "/offer-template.html#" + id2;
            event.source.postMessage({rpcId: rpcId, uri: templateLink}, event.origin);
          }
        });
      } else if (event.data.powerboxRequest) {
        // TODO(now): make this work with GrainView
        var powerboxRequest = event.data.powerboxRequest;
        check(powerboxRequest, Object);
        var rpcId = powerboxRequest.rpcId;

        var powerboxRequestInfo = {
          source: event.source,
          rpcId: rpcId,
          grainId: senderGrain.grainId(),
          origin: event.origin,
          saveLabel: powerboxRequest.saveLabel,
          error: new ReactiveVar(null)
        };

        powerboxRequestInfo.closer = globalTopbar.addItem({
          name: "request",
          template: Template.grainPowerboxRequest,
          popupTemplate: Template.grainPowerboxRequestPopup,
          data: new ReactiveVar(powerboxRequestInfo),
          startOpen: true,
          onDismiss: function () {
            powerboxRequestInfo.source.postMessage(
              {
                rpcId: powerboxRequestInfo.rpcId,
                error: "User canceled request"
              }, powerboxRequestInfo.origin);
            return "remove";
          }
        });
      } else {
        console.log("postMessage from app not understood: " + event.data);
        console.log(event);
      }
    };

    window.addEventListener("message", messageListener, false);
  });
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

function makeGrainIdActive(grainId) {
  console.log("making grain " + grainId + " active");
  var grains = globalGrains.get();
  for (var i = 0 ; i < grains.length ; i++) {
    var grain = grains[i];
    if (grain.grainId() === grainId) {
      if (!grain.isActive()) {
        grain.setActive(true);
      }
    } else {
      if (grain.isActive()) {
        grain.setActive(false);
      }
    }
  }
}

function getActiveGrain(grains) {
  var idx = activeGrainIndex(grains);
  return idx == -1 ? undefined : grains[idx];
}

function activeGrainIndex(grains) {
  for (var i = 0; i < grains.length ; i++) {
    if (grains[i].isActive()) {
      return i;
    }
  }
  return -1;
}

function grainOriginToIndex(grains, origin) {
  for (var i = 0; i < grains.length ; i++) {
    if (grains[i].origin() === origin) {
      return i;
    }
  }
  return -1;
}

function grainIdToIndex(grains, grainId) {
  for (var i = 0; i < grains.length ; i++) {
    var grain = grains[i];
    if (grains[i].grainId() === grainId) {
      return i;
    }
  }
  return -1;
}

function mapGrainStateToTemplateData(grainState) {
  var templateData = {
    grainId: grainState.grainId(),
    active: grainState.isActive(),
    title: grainState.title(),
    error: grainState.error(),
    appOrigin: grainState.origin(),
    hasNotLoaded: !(grainState.hasLoaded()),
    sessionId: grainState.sessionId(),
    path: encodeURIComponent(grainState._originalPath || ""), //TODO: cleanup
    hash: grainState._originalHash || "", // TODO: cleanup
    interstitial: grainState.shouldShowInterstitial(),
    token: grainState.token(),
    viewInfo: grainState.viewInfo(),
  };
  console.log(templateData);
  return templateData;
}

GrainLog = new Mongo.Collection("grainLog");
// Pseudo-collection created by subscribing to "grainLog", implemented in proxy.js.

Router.map(function () {
  this.route("newGrain", {
    path: "/grain/new",
    data: function () {
      if (!Meteor.userId() && !Meteor.loggingIn()) {
        Router.go("root", {}, {replaceState: true});
      }

      return new SandstormAppList(globalDb, globalQuotaEnforcer, this.params.query.highlight);
    },
  });
  this.route("selectGrain", {
    path: "/grain",
    data: function () {
      if (!Meteor.userId() && !Meteor.loggingIn()) {
        Router.go("root", {}, {replaceState: true});
      }

      return new SandstormGrainList(globalDb, globalQuotaEnforcer);
    },
  });
  this.route("grain", {
    path: "/grain/:grainId/:path(.*)?",
    loadingTemplate: "loadingNoMessage",

    waitOn: function () {
      var subscriptions = [
        Meteor.subscribe("grainTopBar", this.params.grainId),
        Meteor.subscribe("devApps"),
      ];
      if (Meteor.settings && Meteor.settings.public &&
          Meteor.settings.public.allowDemoAccounts) {
        Meteor.subscribe("packageByGrainId", this.params.grainId);
      }
      return subscriptions;
    },

    onBeforeAction: function () {
      // Run this hook only once.
      if (this.state.get("beforeActionHookRan")) { return this.next(); }
      this.state.set("beforeActionHookRan", true);

      var grainId = this.params.grainId;
      var path = "/" + (this.params.path || "");
      var query = this.params.query;
      var hash = this.params.hash;
      var grains = globalGrains.get();
      var grainIndex = grainIdToIndex(grains, grainId);
      if (grainIndex == -1) {
        // The element we need to attach our Blaze view to may not exist yet.
        // In that case, defer creating the GrainView until we're sure it's
        // had a chance to render.
        var openView = function openView() {
          var mainContentElement = document.querySelector("body>.main-content");
          if (mainContentElement) {
            var grains = globalGrains.get();
            var grainToOpen = new GrainView(grainId, path, query, hash, undefined,
                mainContentElement);
            grainToOpen.openSession();
            grainIndex = grains.push(grainToOpen) - 1;
            globalGrains.set(grains);
            makeGrainIdActive(grainId);
          } else {
            Meteor.defer(openView);
          }
        };
        openView();
      } else {
        makeGrainIdActive(grainId);
      }
      this.next();
    },

    onStop: function () {
      this.state.set("beforeActionHookRan", undefined);
      globalGrains.get().forEach(function (grain) {
        if (grain.isActive()) {
          grain.setActive(false);
        }
      });
    }
  });

  this.route("/shared/:token/:path(.*)?", {
    name: "shared",
    template: "grain",
    loadingTemplate: "loadingNoMessage",

    waitOn: function () {
      return [
        Meteor.subscribe("devApps"),
        Meteor.subscribe("tokenInfo", this.params.token),

        Meteor.subscribe("grainsMenu")
        // This subscription gives us the data we need for deciding whether to automatically reveal
        // our identity.
        // TODO(soon): Subscribe to contacts instead.
      ];
    },

    onBeforeAction: function () {
      // Run this hook only once. We could accomplish the same thing by using the `onRun()` hook
      // and waiting for `this.ready()`, but for some reason that fails in the case when a user
      // logs in while visiting a /shared/ link.
      if (this.state.get("beforeActionHookRan")) { return this.next(); }
      this.state.set("beforeActionHookRan", true);

      var token = this.params.token;
      var path = "/" + (this.params.path || "");
      var query = this.params.query;
      var hash = this.params.hash;

      var tokenInfo = TokenInfo.findOne({_id: token});
      if (tokenInfo && tokenInfo.apiToken) {
        var grainId = tokenInfo.apiToken.grainId;
        var grains = globalGrains.get();
        var grainIndex = grainIdToIndex(grains, grainId);
        if (grainIndex == -1) {
          var openView = function openView() {
            var mainContentElement = document.querySelector("body>.main-content");
            if (mainContentElement) {
              var grains = globalGrains.get();
              var grainToOpen = new GrainView(grainId, path, query, hash, token,
                                              mainContentElement);
              grainToOpen.openSession();
              grainIndex = grains.push(grainToOpen) - 1;
              globalGrains.set(grains);
              makeGrainIdActive(grainId);
            } else {
              Meteor.defer(openView);
            }
          };
          openView();
        } else {
          makeGrainIdActive(grainId);
        }
      } else if (tokenInfo && tokenInfo.invalidToken) {
        this.state.set("invalidToken", true);
      } else {
        console.error("unrecognized tokenInfo: " + tokenInfo);
      }
      this.next();
    },

    action: function () {
      if (this.state.get("invalidToken")) {
        this.render("invalidToken", {data: {token: this.params.token}});
      } else {
        this.render();
      }
    },

    onStop: function () {
      this.state.set("beforeActionHookRan", undefined);
      this.state.set("invalidToken", undefined);
      globalGrains.get().forEach(function (grain) {
        if (grain.isActive()) {
          grain.setActive(false);
        }
      });
    }
  });

  this.route("grainLog", {
    path: "/grainlog/:grainId",
    layoutTemplate: "noLayout",

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

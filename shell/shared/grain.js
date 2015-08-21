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

  Grains.allow({
    update: function (userId, grain, fieldNames) {
      // Allow owner to rename or privatize grain.
      return userId && grain.userId === userId &&
          ((fieldNames.length === 1 && fieldNames[0] === "title")
           || (fieldNames.length === 1 && fieldNames[0] === "private"));
    }
  });

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

  Meteor.publish("tokenInfo", function (token) {
    // Allows the client side to map a raw token to its entry in ApiTokens.
    check(token, String);

    var hashedToken = Crypto.createHash("sha256").update(token).digest("base64");
    var apiToken = ApiTokens.findOne({_id: hashedToken}, {fields: {grainId: 1, userId: 1}});
    if (!apiToken || (apiToken.owner && !("webkey" in apiToken.owner))) {
      this.added("tokenInfo", token, {invalidToken: true});
    } else {
      this.added("tokenInfo", token, {apiToken: apiToken});
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

var GrainSizes = new Mongo.Collection("grainSizes");
var DisplayNames = new Mongo.Collection("displayNames");
var TokenInfo = new Mongo.Collection("tokenInfo");
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
  var openGrains = [];
  var currentSessionId;
  var currentAppOrigin;
  var currentGrainId;
  var currentSessionGrainSizeSubscription;

  Tracker.autorun(function() {
    // We need to keep track of certain data about each grain we can view
    var grains = globalGrains.get();
    grains.forEach(function(grain) {
      Meteor.subscribe("grainTopBar", grain.grainId);
      Meteor.subscribe("packageByGrainId", grain.grainId);
      var session = Sessions.findOne({grainId: grain.grainId});
      if (session) {
        Meteor.subscribe("grainSize", session._id);
      }
    });
  })

  Template.grain.events({
    "click #incognito-button": function (event) {
      Session.set("visit-token-" + event.currentTarget.getAttribute("data-token"), "incognito");
    },

    "click #redeem-token-button": function (event) {
      Session.set("visit-token-" + event.currentTarget.getAttribute("data-token"), "redeem");
    },
  });

  Template.grainTitle.events({
    "click": function (event) {
      var title = window.prompt("Set new title:", this.title);
      if (title) {
        //if (this.isOwner) {
          var g = getActiveGrain(globalGrains.get());
          if (g) {
            Grains.update(g.grainId, {$set: {title: title}});
          }
          /* TODO(now): fix this for ApiTokens.
        } else {
          var token = ApiTokens.findOne({grainId: this.grainId, objectId: {$exists: false},
                                         "owner.user.userId": Meteor.userId()},
                                        {sort:{created:1}});
          if (token) {
            ApiTokens.update(token._id,
                             {$set: {"owner.user.title" : title}});
          }
        }
          */
      }
    },
  });

  Template.grainDeleteButton.events({
    "click button": function (event) {
      if (this.isOwner) {
        if (window.confirm("Really delete this grain?")) {
          Session.set("showMenu", false);
          Meteor.call("deleteGrain", this.grainId);
          Router.go("root");
        }
      } else {
        if (window.confirm("Really forget this grain?")) {
          Session.set("showMenu", false);
          Meteor.call("forgetGrain", this.grainId);
          Router.go("root");
        }
      }
    },
  });

  Template.grainDebugLogButton.events({
    "click button": function (event) {
      window.open("/grainlog/" + this.grainId, "_blank",
          "menubar=no,status=no,toolbar=no,width=700,height=700");
    },
  });

  Template.grainBackupButton.events({
    "click button": function (event) {
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
  });

  Template.grainRestartButton.events({
    "click button": function (event) {
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
    "click #api-token-popup-closer": function (event) {
      Session.set("show-api-token", false);
    },
    "submit #newApiToken": function (event) {
      event.preventDefault();
      var grainId = this.grainId;
      Session.set("api-token-" + grainId, "pending");
      var roleList = document.getElementById("api-token-role");
      var assignment = {allAccess: null};
      if (roleList && roleList.selectedIndex > 0) {
        assignment = {roleId: roleList.selectedIndex - 1};
      }
      Meteor.call("newApiToken", this.grainId, document.getElementById("api-token-petname").value,
                  assignment, false, undefined,
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
      Grains.update(this.grainId, {$set: {private: true}});
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
      var grainId = this.grainId;
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

  Template.grainSharePopup.onCreated(function () {
    this.currentMode = new ReactiveVar({"shareWithOthers": true});
  });

  Template.grainSharePopup.helpers({
    "currentMode": function() {
      return Template.instance().currentMode.get();
    },
  });

  Template.grain.onCreated(function () {
    this.originalPath = window.location.pathname + window.location.search;
    this.originalHash = window.location.hash;
  });

  //OpenGrains = new Mongo.Collection(null);
  // Client-side collection for containing open grain state
  // Looks like: {
  //  grainId: String,
  //  title: String,
  //  path: Optional(String),
  //  query: Object,
  //  hash: Optional(String),
  //  insOrder: Number,
  //  error: Optional(String)
  // }
  Template.layout.helpers({
    grains: function() {
      var grains = globalGrains.get();
      // map the grains into their template helper form
      var data = grains.map(function(grain) {
        return mapGrainStateToTemplateData(grain);
      });
      return data;
    },
  });

  Template.grain.helpers({
    grainSize: function () {
      var current = getActiveGrain(globalGrains.get());
      if (current) {
        current.dep.depend();
        var session = Sessions.findOne({grainId: current.grainId});
        if (session) {
          sizeEntry = GrainSizes.findOne(session._id);
          if (sizeEntry) {
            return "(" + prettySize(sizeEntry.size) + ")";
          }
        }
      }
      return "";
    },

    setGrainWindowTitle:  function() {
      var current = getActiveGrain(globalGrains.get());
      if (current) {
        current.dep.depend();
        var grain = Grains.findOne({_id: current.grainId});
        var pkg = grain && Packages.findOne({_id: grain.packageId})
        // TODO(now): make this work with ApiTokens too
        var grainTitle = grain && grain.title;
        var appTitle = pkg && pkg.manifest && pkg.manifest.appTitle && pkg.manifest.appTitle.defaultText;
        // TODO(someday) - shouldn't use defaultText
        if (appTitle && grainTitle) {
          document.title = appTitle + " · " + grainTitle + " · Sandstorm";
        } else if (grainTitle) {
          document.title = grainTitle + " · Sandstorm";
        } else {
          document.title = "Sandstorm";
        }
      }
    },

    displayWebkeyButton: function () {
      return Meteor.userId() || !this.oldSharingModel;
    },

    showPowerboxOffer: function () {
      var session = Sessions.findOne({_id: this.sessionId}, {fields: {powerboxView: 1}});
      return session && session.powerboxView && !!session.powerboxView.offer;
    },
  });

  Template.grainTitle.helpers({
    title: function () {
      var grain = getActiveGrain(globalGrains.get());
      // TODO(now): make this work with ApiTokens
      var g = grain && Grains.findOne({_id: grain.grainId});
      return (g && g.title) || "Untitled grain";
    }
  });

  Template.grainApiTokenPopup.helpers({
    displayToken: function() {
      return !this.revoked && !this.expiresIfUnused && !this.parentToken;
    },
  });

  Template.whoHasAccessPopup.onCreated(function () {
    var instance = this;
    instance.grainId = this.data.grainId;
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
      var roles = instance.data.viewInfo.roles;
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
  });

  Template.shareWithOthers.helpers({
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
      var grainId = this.grainId;
      var title = this.title;

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

      var session = Sessions.findOne({_id: this.sessionId}, {fields: {powerboxView: 1}});
      return session && session.powerboxView && session.powerboxView.offer;
    },
  });

  /*
  function setCurrentSessionId(sessionId, appOrigin, grainId) {

    if (currentSessionGrainSizeSubscription) {
      currentSessionGrainSizeSubscription.stop();
      currentSessionGrainSizeSubscription = undefined;
    }
    currentSessionId = sessionId;
    currentAppOrigin = appOrigin;
    currentGrainId = grainId;
    if (sessionId) {
      currentSessionGrainSizeSubscription = Meteor.subscribe("grainSize", sessionId);
    }
  }
  */

  // Send a keep-alive for each grain every now and then.
  Meteor.setInterval(function () {
    var grains = globalGrains.get();
    if (!grains) return;
    grains.forEach(function (grain) {
      if (grain.sessionId) {
        // TODO(soon):  Investigate what happens in background tabs.  Maybe arrange to re-open the
        //   app if it dies while in the background.
        console.log("keepalive: ", new Date());
        Meteor.call("keepSessionAlive", grain.sessionId, function (error, result) {
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

  // Message handler for changing path in user's URL bar
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
        // Ignore it.
        console.log("ignoring postmessage from unrecognized origin", event.origin);
        return;
      }
      var senderGrain = grains[senderGrainIndex];

      /* disabled because multi-grain breaks things
      if (event.origin !== currentAppOrigin) {
        // TODO: better handling of multiple grain postMessage() calls.
        // setPath should only change the window state if it's the currently-open grain.
        // setTitle should set the title of the sending origin's state, not a singleton global.
        // renderTemplate should always work.
        // powerboxRequest...I'm not sure yet.
        return;
      }
      */
      if (event.data.setPath) {
        var prefix = senderGrain.rootPath.match("/[^/]*/[^/]*")[0];
        if (prefix.lastIndexOf("/grain/", 0) !== 0 &&
            prefix.lastIndexOf("/shared/", 0) !== 0) {
          throw new Error("Don't know how to add in-grain path to current URL. " +
                          "This is a bug in Sandstorm; please file a report.");
        }

        senderGrain.rootPath = prefix + event.data.setPath;
        if (senderGrain.active) {
          window.history.replaceState({}, "", prefix + event.data.setPath);
        }
        senderGrain.dep.changed();
      } else if (event.data.setTitle) {
        //Session.set("grainFrameTitle", event.data.setTitle);
        senderGrain.frameTitle = event.data.setTitle;
        senderGrain.dep.changed();
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
        Meteor.call("newApiToken", senderGrain.grainId, petname, assignment, forSharing,
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
        var powerboxRequest = event.data.powerboxRequest;
        check(powerboxRequest, Object);
        var rpcId = powerboxRequest.rpcId;

        var powerboxRequestInfo = {
          source: event.source,
          rpcId: rpcId,
          grainId: currentGrainId,
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
    if (grain.grainId === grainId) {
      if (!grain.active) {
        grain.active = true;
        grain.dep.changed();
      }
    } else {
      if (grain.active) {
        grain.active = false;
        grain.dep.changed();
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
    if (grains[i].active) {
      return i;
    }
  }
  return -1;
}

function grainOriginToIndex(grains, origin) {
  for (var i = 0; i < grains.length ; i++) {
    if (grains[i].cachedAppOrigin === origin) {
      return i;
    }
  }
  return -1;
}

function grainIdToIndex(grains, grainId) {
  for (var i = 0; i < grains.length ; i++) {
    var grain = grains[i];
    if (grains[i].grainId === grainId) {
      return i;
    }
  }
  return -1;
}

function prepareNewGrainSession(grainId, path, query, hash) {
  console.log("prepareNewGrainSession " + grainId + ' ' + path + ' ' + query + ' ' + hash);
  var title;
  var grain = Grains.findOne(grainId);
  if (grain) {
    title = grain.title;
  } else if (Meteor.userId()) {
    var token = ApiTokens.findOne({grainId: grainId,
                                   "owner.user.userId": Meteor.userId()},
                                  {sort:{created:1}});
    if (token) {
      title = token.owner.user.title;
    }
  }
  var grainState = {
    grainId: grainId,
    path: path,
    query: query,
    hash: hash,
    dep: new Tracker.Dependency,
  };

  Meteor.call("openSession", grainId, function(error, result) {
    if (error) {
      console.log("openSession error");
      grainState.error = error.message;
      grainState.openingSession = undefined;
      grainState.dep.changed();
    } else if (result.redirectToGrain) {
      console.log("openSession redirectToGrain");
      grainState.grainId = result.redirectToGrain;
      grainState.dep.changed();
      // TODO(now): verify that this is, in fact, the grain we're supposed to be showing?
      // Make sure to carry over any within-grain path.
      var routeParams = { grainId: result.redirectToGrain };
      if (grainState.path) {
        routeParams.path = grainState.path;
      }
      var urlParams = {};
      if (grainState.query) {
        urlParams.query = grainState.query;
      }
      if (grainState.hash) {
        urlParams.hash = grainState.hash;
      }
      // OK, go to the grain.
      return Router.go("grain", routeParams, urlParams);
    } else {
      console.log("openSession success");
      console.log(result);
      if (result.title) { grainState.title = result.title; }
      grainState.grainId = result.grainId;
      var subscription = Meteor.subscribe("sessions", result.sessionId);
      Sessions.find({_id : result.sessionId}).observeChanges({
        removed: function(session) {
          subscription.stop();
          grainState.sessionSub = undefined;
          grainState.dep.changed();
        },
        added: function(session) {
          grainState.openingSession = undefined;
          grainState.dep.changed();
        }
      });
      grainState.sessionSub = subscription;
      grainState.grainSizeSub = Meteor.subscribe("grainSize", result.sessionId);
      grainState.dep.changed();
    }

  });
  return grainState;

  /*
  var thisGrain = grainRouteHelper(this, {
        grainId: grainId,
        title: title,
        isOwner: grain && grain.userId && grain.userId === Meteor.userId(),
        isDemoUser: isDemoUser(),
        oldSharingModel: grain && !grain.private,
        state: new ReactiveDict(),
        grainTracker: new Tracker.Dependency(),
      },
      "openSession",
      grainId,
      "/grain/" + grainId);
  return thisGrain;
  */
}
function mapGrainStateToTemplateData(grainState) {
  grainState.dep.depend();

  var title;
  var token;
  var grain = Grains.findOne({_id: grainState.grainId});
  if (grain) {
    title = grain.title;
  } else if (Meteor.userId()) {
    token = ApiTokens.findOne({grainId: grainState.grainId,
                                   "owner.user.userId": Meteor.userId()},
                                  {sort:{created:1}});
    if (token) {
      title = token.owner.user.title;
    }
  }
  var session = Sessions.findOne({grainId: grainState.grainId});
  if (session) {
    var appOrigin = window.location.protocol + "//" + makeWildcardHost(session.hostId);
    grainState.cachedAppOrigin = appOrigin;
  }

  var templateData = {
    grainId: grainState.grainId,
    active: grainState.active,
    title: title,
    error: grainState.error,
    appOrigin: session && appOrigin,
    hasNotLoaded: !(session && session.hasLoaded),
    sessionId: session && session._id,
    path: encodeURIComponent(grainState.path || ""),
    hash: grainState.hash || "",
    viewInfo: session && session.viewInfo,
  };
  /*
  if (grainState.grainId) {
    templateData.rootPath = "/grain/" + grainState.grainId;
  }
  if (grainState.sharedToken) {
    templateData.rootPath = "/shared/" + grainState.sharedToken;
  }
  */
  //templateData.showMenu = Session.get("showMenu");
  return templateData;
}

function grainRouteHelper(route, grainState, openSessionMethod, openSessionArg, rootPath) {
  var grainId = grainState.grainId;

  var apiToken = Session.get("api-token-" + grainId);

  grainState.apiToken = apiToken;
  grainState.apiTokenPending = (apiToken === "pending");
  grainState.showApiToken = Session.get("show-api-token");
  grainState.existingTokens = ApiTokens.find({grainId: grainId, userId: Meteor.userId(),
                                          forSharing: {$ne: true},
                                          $or: [{owner: {webkey: null}},
                                                {owner: {$exists: false}}],
                                          expiresIfUnused: null}).fetch();
  grainState.showShareGrain = Session.get("show-share-grain");
  grainState.showMenu = Session.get("showMenu");
  grainState.rootPath = rootPath;

  var err = grainState.state.get("error");
  if (err) {
    grainState.error = err;
    return grainState;
  }

  var session = Sessions.findOne({grainId: grainId});
  if (session) {
    grainState.state.set("openingSession", undefined);
    grainState.appOrigin = window.location.protocol + "//" + makeWildcardHost(session.hostId);
    grainState.grainSizeSubscription = Meteor.subscribe("grainSize", session._id);
    grainState.sessionId = session._id;
    grainState.viewInfo = session.viewInfo;
    return grainState;
  } else if (grainState.state.get("openingSession")) {
    return grainState;
  } else {
    grainState.state.set("openingSession", true);
    Meteor.call(openSessionMethod, openSessionArg, function (error, result) {
      if (error) {
        grainState.state.set("error", error.message);
        grainState.state.set("openingSession", undefined);
      } else if (result.redirectToGrain) {
        // Make sure to carry over any within-grain path.
        var routeParams = { grainId: result.redirectToGrain };
        if (grainState.params.path) {
          routeParams.path = grainState.params.path;
        }
        var urlParams = {};
        if (grainState.params.query) {
          urlParams.query = grainState.params.query;
        }
        if (grainState.params.hash) {
          urlParams.hash = grainState.params.hash;
        }

        // OK, go to the grain.
        return Router.go("grain", routeParams, urlParams);
      } else {
        grainState.state.set("title", result.title);
        grainState.state.set("grainId", result.grainId);
        var subscription = Meteor.subscribe("sessions", result.sessionId);
        Sessions.find({_id : result.sessionId}).observeChanges({
          removed: function(session) {
            subscription.stop();
            grainState.sessionSub = undefined;
          },
          added: function(session) {
            grainState.state.openingSession = undefined;
          }
        });
      }
    });
    return grainState;
  }
}

GrainLog = new Mongo.Collection("grainLog");
// Pseudo-collection created by subscribing to "grainLog", implemented in proxy.js.

Router.map(function () {
  this.route("newGrain", {
    path: "/grain/new",
    data: function () {
      return new SandstormAppList(globalDb);
    },
  });
  this.route("selectGrain", {
    path: "/grain",
    data: function () {
      return new SandstormGrainList(globalDb);
    },
  });
  this.route("grain", {
    path: "/grain/:grainId/:path(.*)?",

    waitOn: function () {
      var subscriptions = [
        Meteor.subscribe("grainTopBar", this.params.grainId),
        // Needed to show the app icon and app title (accessibility text) in the sidebar.
        Meteor.subscribe("packageByGrainId", this.params.grainId),
        Meteor.subscribe("devApps"),
      ];
      return subscriptions;
    },

    onRun: function () {
      var grainId = this.params.grainId;
      var path = this.params.path;
      var query = this.params.query;
      var hash = this.params.hash;
      var grains = globalGrains.get();
      var grainIndex = grainIdToIndex(grains, grainId);
      if (grainIndex == -1) {
        var grainToOpen = prepareNewGrainSession(grainId, path, query, hash);
        grainIndex = grains.push(grainToOpen) - 1;
        globalGrains.set(grains);
      }
      makeGrainIdActive(grainId);
      this.next();
    },

    onStop: function () {
      globalGrains.get().forEach(function (grain) {
        if (grain.active) {
          grain.active = false;
          grain.dep.changed();
        }
      });
    }
  });

  this.route("/shared/:token/:path(.*)?", {
    name: "shared",
    template: "grain",

    waitOn: function () {
      return [
        Meteor.subscribe("devApps"),
        Meteor.subscribe("tokenInfo", this.params.token),

        Meteor.subscribe("grainsMenu"),
        // This subscription gives us the data we need for deciding whether to automatically reveal
        // our identity.
        // TODO(soon): Subscribe to contacts instead.
      ];
    },

    data: function() {
      if (!this.ready || Meteor.loggingIn()) {
        return;
      }
      if (Meteor.userId() && !Session.get("visit-token-" + this.params.token)) {
        var tokenInfo = TokenInfo.findOne(this.params.token);
        if (!tokenInfo || !tokenInfo.apiToken) {
          this.state.set("error", "invalid authorization token");
        } else {
          this.state.set("error", undefined);
          var apiToken = tokenInfo.apiToken;
          if (!Grains.findOne({_id: apiToken.grainId, userId: Meteor.userId()}) &&
              !ApiTokens.findOne({userId: apiToken.userId, "owner.user.userId": Meteor.userId()})) {
            // The user neither owns the grain nor holds any sturdyrefs from this sharer.
            // Therefore, we ask whether they would like to go incognito.
            // TODO(soon): Base this decision on the contents of the Contacts collection.
            return {interstitial: true, token: this.params.token};
          } else {
            Session.set("visit-token-" + this.params.token, "redeem");
          }
        }
      }
      if (this.state.get("grainId")) {
        Session.set("api-token-" + this.state.get("grainId"),
                    window.location.protocol + "//" + makeWildcardHost("api") + "#"
                    + this.params.token);
      }
      return grainRouteHelper(this,
                              {grainId: this.state.get("grainId"), title: this.state.get("title")},
                              "openSessionFromApiToken",
                              {token: this.params.token,
                               incognito:
                                  "redeem" !== Session.get("visit-token-" + this.params.token)},
                              "/shared/" + this.params.token);
    },

    onStop: function () {
      /*
      setCurrentSessionId(undefined, undefined, undefined);
      Session.set("grainFrameTitle", undefined);
      document.title = DEFAULT_TITLE;
      */
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

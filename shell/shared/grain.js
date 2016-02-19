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

const DEFAULT_TITLE = "Sandstorm";

if (Meteor.isServer) {
  const Crypto = Npm.require("crypto");

  Meteor.publish("grainTopBar", function (grainId) {
    check(grainId, String);

    const result = [
      Grains.find({
        _id: grainId,
        $or: [
          { userId: this.userId },
          { private: { $ne: true } },
        ],
      }, {
        fields: {
          title: 1,
          userId: 1,
          identityId: 1,
          private: 1,
        },
      }),
    ];
    if (this.userId) {
      const myIdentityIds = SandstormDb.getUserIdentityIds(globalDb.getUser(this.userId));
      result.push(ApiTokens.find({
        grainId: grainId,
        $or: [
          { "owner.user.identityId": { $in: myIdentityIds } },
          { identityId: { $in: myIdentityIds } },
        ],
      }));
    }

    return result;
  });

  // We allow users to learn package information about a grain they own.
  // This is used for obtaining icon and app title information for grains
  // you own, which is used in the sidebar. It is not a security/privacy
  // risk since it only exposes this information for grains the user owns.
  Meteor.publish("packageByGrainId", function (grainId) {
    check(grainId, String);
    const publishThis = [];
    // We need to publish the packageId so that client-side code can
    // find the right package.
    const thisGrainCursor = Grains.find({
      _id: grainId,
      userId: this.userId,
    }, {
      fields: { packageId: 1 },
    });
    publishThis.push(thisGrainCursor);

    if (thisGrainCursor.count()) {
      const thisGrain = thisGrainCursor.fetch()[0];
      const thisPackageCursor = Packages.find({ _id: thisGrain.packageId });
      publishThis.push(thisPackageCursor);
    }

    return publishThis;
  });

  Meteor.publish("tokenInfo", function (token) {
    // Allows the client side to map a raw token to its entry in ApiTokens, and the additional
    // metadata that it will need to display the app icon and title.  We do not care about making
    // the metadata reactive.
    check(token, String);

    const hashedToken = Crypto.createHash("sha256").update(token).digest("base64");
    const apiToken = ApiTokens.findOne({
      _id: hashedToken,
    }, {
      fields: {
        grainId: 1,
        owner: 1,
      },
    });
    if (!apiToken) {
      this.added("tokenInfo", token, { invalidToken: true });
    } else {
      const grainId = apiToken.grainId;
      const grain = Grains.findOne({
        _id: grainId,
      }, {
        fields: {
          packageId: 1,
          appId: 1,
        },
      });
      if (!grain) {
        this.added("tokenInfo", token, { invalidToken: true });
      } else {
        if (apiToken.owner && apiToken.owner.user) {
          let identity = globalDb.getIdentity(apiToken.owner.user.identityId);
          let metadata = apiToken.owner.user.denormalizedGrainMetadata;
          if (identity && metadata) {
            this.added("tokenInfo", token,
                       { identityOwner: _.pick(identity, "_id", "profile"),
                        grainId: grainId,
                        grainMetadata: metadata, });
          } else {
            this.added("tokenInfo", token, { invalidToken: true });
          }
        } else if (!apiToken.owner || "webkey" in apiToken.owner) {
          let pkg = Packages.findOne({ _id: grain.packageId }, { fields: { manifest: 1 } });
          let appTitle = (pkg && pkg.manifest && pkg.manifest.appTitle) || { defaultText: "" };
          let appIcon = undefined;
          if (pkg && pkg.manifest && pkg.manifest.metadata && pkg.manifest.metadata.icons) {
            let icons = pkg.manifest.metadata.icons;
            appIcon = icons.grain || icons.appGrid;
          }

          let denormalizedGrainMetadata = {
            appTitle: appTitle,
            icon: appIcon,
            appId: appIcon ? undefined : grain.appId,
          };
          this.added("tokenInfo", token,
                     { webkey: true,
                      grainId: grainId,
                      grainMetadata: denormalizedGrainMetadata, });
        } else {
          this.added("tokenInfo", token, { invalidToken: true });
        }
      }
    }

    this.ready();
    return;
  });

  Meteor.publish("grainSize", function (grainId) {
    // Publish pseudo-collection containing the size of the grain opened in the given session.
    check(grainId, String);

    const grain = Grains.findOne(grainId);
    if (!grain || grain.userId !== this.userId) {
      return [];
    }

    const supervisor = globalBackend.cap().getGrain(this.userId, grainId).supervisor;

    const _this = this;
    let stopped = false;
    let promise = getGrainSize(supervisor);

    function getNext(oldSize) {
      promise = getGrainSize(supervisor, oldSize);
      promise.then(function (size) {
        if (!stopped) {
          if (size !== oldSize) {  // sometimes there are false alarms
            _this.changed("grainSizes", grainId, { size: size });
          }

          getNext(size);
        }
      }, function (err) {

        if (!stopped) {
          if (err.kjType === "disconnected") {
            _this.stop();
          } else {
            _this.error(err);
          }
        }
      });
    }

    promise.then(function (size) {
      if (!stopped) {
        _this.added("grainSizes", grainId, { size: size });
        _this.ready();
        getNext(size);
      }
    }, function (err) {

      if (!stopped) {
        if (err.kjType === "disconnected") {
          _this.stop();
        } else {
          _this.error(err);
        }
      }
    });

    _this.onStop(function () {
      stopped = true;
      promise.cancel();
    });
  });
}

// GrainSizes is used by grainview.js
GrainSizes = new Mongo.Collection("grainSizes");
// TokenInfo is used by grainview.js
TokenInfo = new Mongo.Collection("tokenInfo");
// Pseudo-collections published above.

Meteor.methods({
  deleteGrain: function (grainId) {
    check(grainId, String);

    if (this.userId) {
      const grain = Grains.findOne({ _id: grainId, userId: this.userId });
      if (grain) {
        Grains.remove(grainId);
        ApiTokens.remove({
          grainId: grainId,
          $or: [
            { owner: { $exists: false } },
            { owner: { webkey: null } },
          ],
        });
        if (grain.lastUsed) {
          DeleteStats.insert({ type: isDemoUser() ? "demoGrain" : "grain",
                              lastActive: grain.lastUsed, appId: grain.appId, });
        }

        if (!this.isSimulation) {
          waitPromise(globalBackend.deleteGrain(grainId, this.userId));
          Meteor.call("deleteUnusedPackages", grain.appId);
        }
      }
    }
  },

  forgetGrain: function (grainId, identityId) {
    // TODO(cleanup): For now we are ignoring `identityId`, but maybe we should expose finer-grained
    //  forgetting.

    check(grainId, String);
    check(identityId, String);

    if (!this.userId) {
      throw new Meteor.Error(403, "Must be logged in to forget a grain.");
    }

    SandstormDb.getUserIdentityIds(Meteor.user()).forEach(function (identityId) {
      ApiTokens.remove({ grainId: grainId, "owner.user.identityId": identityId });
    });
  },

  updateGrainPreferredIdentity: function (grainId, identityId) {
    check(grainId, String);
    check(identityId, String);
    if (!this.userId) {
      throw new Meteor.Error(403, "Must be logged in.");
    }

    const grain = globalDb.getGrain(grainId) || {};
    if (!grain.userId === this.userId) {
      throw new Meteor.Error(403, "Grain not owned by current user.");
    }

    Grains.update({ _id: grainId }, { $set: { identityId: identityId } });
  },

  updateGrainTitle: function (grainId, newTitle, identityId) {
    check(grainId, String);
    check(newTitle, String);
    check(identityId, String);
    if (this.userId) {
      const grain = Grains.findOne(grainId);
      if (grain) {
        if (grain.userId === this.userId) {
          Grains.update({ _id: grainId, userId: this.userId }, { $set: { title: newTitle } });
        } else {
          if (!globalDb.userHasIdentity(this.userId, identityId)) {
            throw new Meteor.Error(403, "Current user does not have identity " + identityId);
          }

          const token = ApiTokens.findOne({
            grainId: grainId,
            objectId: { $exists: false },
            "owner.user.identityId": identityId,
          }, {
            sort: { created: 1 },
          });
          if (token) {
            ApiTokens.update(token._id, { $set: { "owner.user.title": newTitle } });
          }
        }
      }
    }
  },

  privatizeGrain: function (grainId) {
    check(grainId, String);
    if (this.userId) {
      Grains.update({ _id: grainId, userId: this.userId }, { $set: { private: true } });
    }
  },

  inviteUsersToGrain: function (origin, identityId, grainId, title, roleAssignment,
                                contacts, message) {
    if (!this.isSimulation) {
      check(origin, String);
      check(identityId, String);
      check(grainId, String);
      check(title, String);
      check(roleAssignment, roleAssignmentPattern);
      check(contacts, [
        {
          _id: String,
          isDefault: Match.Optional(Boolean),
          profile: Match.ObjectIncluding({
            service: String,
            name: String,
            intrinsicName: String,
          }),
        },
      ]);
      check(message, { text: String, html: String });
      if (!this.userId) {
        throw new Meteor.Error(403, "Must be logged in to share by email.");
      }

      if (!globalDb.userHasIdentity(this.userId, identityId)) {
        throw new Meteor.Error(403, "Not an identity of the current user: " + identityId);
      }

      if (contacts.length === 0) {
        throw new Meteor.Error(400, "No contacts were provided.");
      }

      const accountId = this.userId;
      const identity = globalDb.getIdentity(identityId);
      const sharerDisplayName = identity.profile.name;
      const outerResult = { successes: [], failures: [] };
      contacts.forEach(function (contact) {
        if (contact.isDefault && contact.profile.service === "email") {
          const emailAddress = contact.profile.intrinsicName;
          const result = SandstormPermissions.createNewApiToken(
            globalDb, { identityId: identityId, accountId: accountId }, grainId,
            "email invitation for " + emailAddress,
            roleAssignment, { webkey: { forSharing: true } });
          const url = origin + "/shared/" + result.token;
          const html = message.html + "<br><br>" +
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
                "\n\nNote: If you forward this email to other people, they will be able to " +
                "access the share as well. To prevent this, remove the link before forwarding.",
              html: html,
            });
          } catch (e) {
            outerResult.failures.push({ contact: contact, error: e.toString() });
          }
        } else {
          let result = SandstormPermissions.createNewApiToken(
            globalDb, { identityId: identityId, accountId: accountId }, grainId,
            "direct invitation to " + contact.profile.intrinsicName,
            roleAssignment, { user: { identityId: contact._id, title: title } });
          try {
            const identity = Meteor.users.findOne({ _id: contact._id });
            const emailAddress = SandstormDb.getVerifiedEmails(identity)[0];
            const url = origin + "/shared/" + result.token;
            if (emailAddress) {
              const intrinsicName = contact.profile.intrinsicName;
              let loginNote;
              if (contact.profile.service === "google") {
                loginNote = "Google account with address " + emailAddress;
              } else if (contact.profile.service === "github") {
                loginNote = "Github account with username " + intrinsicName;
              } else if (contact.profile.service === "email") {
                loginNote = "email address " + intrinsicName;
              } else {
                throw new Meteor.Error(500, "Unknown service to email share link.");
              }

              const html = message.html + "<br><br>" +
                  "<a href='" + url + "' style='display:inline-block;text-decoration:none;" +
                  "font-family:sans-serif;width:200px;min-height:30px;line-height:30px;" +
                  "border-radius:4px;text-align:center;background:#428bca;color:white'>" +
                  "Open Shared Grain</a><div style='font-size:8pt;font-style:italic;color:gray'>" +
                  "Note: You will need to log in with your " + loginNote +
                  " to access this grain.";
              SandstormEmail.send({
                to: emailAddress,
                from: "Sandstorm server <no-reply@" + HOSTNAME + ">",
                subject: sharerDisplayName + " has invited you to join a grain: " + title,
                text: message.text + "\n\nFollow this link to open the shared grain:\n\n" + url +
                  "\n\nNote: You will need to log in with your " + loginNote +
                  " to access this grain.",
                html: html,
              });
            } else {
              outerResult.failures.push({ contact: contact, warning: "User does not have a " +
                "verified email, so notification of this share was not sent to them. Please " +
                "manually share " + url + " with them.", });
            }
          } catch (e) {
            outerResult.failures.push({ contact: contact, error: e.toString(),
              warning: "Share succeeded, but there was an error emailing the user. Please " +
              "manually share " + url + " with them.", });
          }
        }
      });

      return outerResult;
    }
  },
});

if (Meteor.isClient) {
  Tracker.autorun(function () {
    // We need to keep track of certain data about each grain we can view.
    // TODO(cleanup): Do these in GrainView to avoid spurious resubscribes.
    const grains = globalGrains.get();
    grains.forEach(function (grain) {
      grain.depend();
      const grainId = grain.grainId();
      if (grainId) {
        Meteor.subscribe("grainTopBar", grainId);
        if (grain.isOwner()) {
          Meteor.subscribe("packageByGrainId", grainId);
        }

        const token = grain.token();
        if (token) {
          Meteor.subscribe("tokenInfo", token);
        }
      }
    });
  });

  Template.layout.events({
    "click .incognito-button": function (event) {
      console.log(event);
      const grains = globalGrains.get();
      const token = event.currentTarget.getAttribute("data-token");
      if (token) {
        grains.forEach(function (grain) {
          if (grain.token() == token) {
            grain.doNotRevealIdentity();
          }
        });
      } else {
        console.error("Interstitial prompt answered, but no token present?");
      }
    },
  });

  const promptNewTitle = function () {
    const grain = getActiveGrain(globalGrains.get());
    if (grain) {
      let prompt = "Set new title:";
      if (!grain.isOwner()) {
        prompt = "Set a new personal title: (does not change the owner's title for this grain)";
      }

      const title = window.prompt(prompt, grain.title());
      if (title) {
        grain.setTitle(title);
      }
    }
  };

  Template.grainTitle.events({
    click: function (event) {
      promptNewTitle();
    },

    keydown: function (event) {
      if ((event.keyCode === 13) || (event.keyCode === 32)) {
        // Allow space or enter to trigger renaming the grain - Firefox doesn't treat enter on the
        // focused element as click().
        promptNewTitle();
        event.preventDefault();
      }
    },
  });

  Template.grainDeleteButton.events({
    "click button": function (event) {
      const grains = globalGrains.get();
      const activeIndex = activeGrainIndex(grains);
      const activeGrain = grains[activeIndex];
      const newActiveIndex = (activeIndex == grains.length - 1) ? activeIndex - 1 : activeIndex;
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
            Router.go(grains[newActiveIndex].route());
          }
        }
      } else {
        if (window.confirm("Really forget this grain?")) {
          const identityId = activeGrain.identityId();
          if (identityId) {
            Meteor.call("forgetGrain", activeGrain.grainId(), identityId);
          }
          // TODO: extract globalGrains into a class that has a "close" method for closing the active view
          activeGrain.destroy();
          if (grains.length == 1) {
            globalGrains.set([]);
            Router.go("root");  // will redirect to the right place
          } else {
            grains.splice(activeIndex, 1);
            grains[newActiveIndex].setActive(true);
            globalGrains.set(grains);
            Router.go(grains[newActiveIndex].route());
          }
        }
      }
    },
  });

  Template.grainDebugLogButton.events({
    "click button": function (event) {
      this.reset();
      const activeGrain = getActiveGrain(globalGrains.get());
      window.open("/grainlog/" + activeGrain.grainId(), "_blank",
          "menubar=no,status=no,toolbar=no,width=700,height=700");
    },
  });

  Template.grainBackupButton.onCreated(function () {
    this.isLoading = new ReactiveVar(false);
  });

  Template.grainBackupButton.helpers({
    isLoading: function () {
      return Template.instance().isLoading.get();
    },
  });

  Template.grainBackupButton.events({
    "click button": function (event, template) {
      template.isLoading.set(true);
      this.reset();
      const activeGrain = getActiveGrain(globalGrains.get());
      Meteor.call("backupGrain", activeGrain.grainId(), function (err, id) {
        template.isLoading.set(false);
        if (err) {
          alert("Backup failed: " + err); // TODO(someday): make this better UI
        } else {
          // Firefox for some reason decides to kill all websockets when we try to download the file
          // by navigating there. So we're left doing a dirty hack to get around the popup blocker.
          const isFirefox = typeof InstallTrigger !== "undefined";

          if (isFirefox) {
            const save = document.createElement("a");
            save.href = "/downloadBackup/" + id;

            save.download = activeGrain.title() + ".zip";
            const event = document.createEvent("MouseEvents");
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
      const activeGrain = getActiveGrain(globalGrains.get());
      const grainId = activeGrain.grainId();

      Meteor.call("shutdownGrain", grainId, function (err) {
        if (err) {
          alert("Restart failed: " + err); // TODO(someday): make this better UI
        } else {
          const frames = document.getElementsByClassName("grain-frame");
          for (let i = 0; i < frames.length; i++) {
            const frame = frames[i];
            if (frame.dataset.grainid == grainId) {
              frame.src = frame.src;
            }
          }
        }
      });
    },
  });

  function selectElementContents(element) {
    if (document.body.createTextRange) {
      const range = document.body.createTextRange();
      range.moveToElementText(element);
      range.select();
    } else if (window.getSelection) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  function selectTargetContents(event) {
    event.preventDefault();
    selectElementContents(event.currentTarget);
  }

  Template.grainApiTokenPopup.events({
    "click .copy-me": selectTargetContents,
    "focus .copy-me": selectTargetContents,
    "submit .newApiToken": function (event) {
      event.preventDefault();
      const activeGrain = getActiveGrain(globalGrains.get());
      const grainId = activeGrain.grainId();
      activeGrain.setGeneratedApiToken("pending");
      const roleList = document.getElementById("api-token-role");
      // TODO(cleanup): avoid using global ids; select a child of the current template instead
      let assignment = { allAccess: null };
      if (roleList && roleList.selectedIndex > 0) {
        assignment = { roleId: roleList.selectedIndex - 1 };
      }

      Meteor.call("newApiToken", { identityId: activeGrain.identityId() }, grainId,
                  document.getElementById("api-token-petname").value,
                  assignment, { webkey: { forSharing: false } },
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
      const activeGrain = getActiveGrain(globalGrains.get());
      activeGrain.setGeneratedApiToken(undefined);
    },

    "click button.revoke-token": function (event) {
      Meteor.call("updateApiToken", event.currentTarget.getAttribute("data-token-id"),
                  { revoked: true });
    },

    "click .token-petname": function (event) {
      // TODO(soon): Find a less-annoying way to get this input, perhaps by allowing the user
      //   to edit the petname in place.
      const petname = window.prompt("Set new label:", this.petname);
      if (petname) {
        Meteor.call("updateApiToken", event.currentTarget.getAttribute("data-token-id"),
                    { petname: petname });
      }
    },
  });

  Template.grainSharePopup.events({
    "click .copy-me": selectTargetContents,
    "focus .copy-me": selectTargetContents,
    "click #share-grain-popup-closer": function (event) {
      Session.set("show-share-grain", false);
    },

    "click button.who-has-access": function (event, instance) {
      event.preventDefault();
      const closer = globalTopbar.addItem({
        name: "who-has-access",
        template: Template.whoHasAccess,
        popupTemplate: Template.whoHasAccessPopup,
        data: new ReactiveVar(instance.data),
        startOpen: true,
        onDismiss: function () {
          return "remove";
        },
      });
    },

    "click #privatize-grain": function (event) {
      Meteor.call("privatizeGrain", getActiveGrain(globalGrains.get()).grainId());
    },

    "click a.open-non-anonymously": function (event) {
      event.preventDefault();
      globalTopbar.closePopup();
      getActiveGrain(globalGrains.get()).reset();
      getActiveGrain(globalGrains.get()).openSession();
    },
  });

  Template.shareWithOthers.onRendered(function () {
    this.find("[role=tab]").focus();
  });

  const activateTargetTab = function (event, instance) {
    // Deactivate all tabs and all tab panels.
    instance.findAll("ul[role=tablist]>li[role=tab]").forEach(function (element) {
      element.setAttribute("aria-selected", false);
    });

    instance.findAll(".tabpanel").forEach(function (element) {
      element.setAttribute("aria-hidden", true);
    });

    // Activate the tab header the user selected.
    event.currentTarget.setAttribute("aria-selected", true);
    // Show the corresponding tab panel.
    const idToShow = event.currentTarget.getAttribute("aria-controls");
    const tabPanelToShow = instance.find("#" + idToShow);
    tabPanelToShow.setAttribute("aria-hidden", false);
  };

  Template.shareWithOthers.events({
    "click #send-invite-tab-header": activateTargetTab,
    "click #shareable-link-tab-header": activateTargetTab,
    "keydown [role=tab]": function (event, template) {
      if (event.keyCode == 38 || event.keyCode == 40) { // up and down arrows
        event.preventDefault();
      }

      const $focus = $(template.find(":focus"));
      const $items = template.$("[role=tab]:visible");
      const focusIndex = $items.index($focus);
      let newFocusIndex;
      if (event.keyCode == 37) { // left arrow
        event.preventDefault();
        newFocusIndex = focusIndex - 1;
        if (newFocusIndex == -1) {
          newFocusIndex = $items.length - 1;
        }
      } else if (event.keyCode == 39) { // right arrow
        event.preventDefault();
        newFocusIndex = focusIndex + 1;
        if (newFocusIndex >= $items.length) {
          newFocusIndex = 0;
        }
      } else if (event.keyCode == 13) { // Enter key
        event.preventDefault();
        activateTargetTab(event, template);
      }

      if (newFocusIndex != null) {
        $items.attr("tabindex", "-1");
        const $newFocus = $($items[newFocusIndex]);
        $newFocus.attr("tabindex", "0");
        $newFocus.focus();
      }
    },
  });

  Template.shareableLinkTab.events({
    "change .share-token-role": function (event, instance) {
      const success = instance.completionState.get().success;
      if (success) {
        const roleList = event.target;
        let assignment;
        if (roleList) {
          assignment = { roleId: roleList.selectedIndex };
        } else {
          assignment = { none: null };
        }

        Meteor.call("updateApiToken", success.id, { roleAssignment: assignment }, function (error) {
          if (error) {
            console.error(error.stack);
          }
        });
      }
    },

    "change .label": function (event, instance) {
      const success = instance.completionState.get().success;
      if (success) {
        const label = event.target.value;
        Meteor.call("updateApiToken", success.id, { petname: label }, function (error) {
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

      const currentGrain = getActiveGrain(globalGrains.get());
      const grainId = currentGrain.grainId();
      const roleList = event.target.getElementsByClassName("share-token-role")[0];
      let assignment;
      if (roleList) {
        assignment = { roleId: roleList.selectedIndex };
      } else {
        assignment = { none: null };
      }

      instance.completionState.set({ pending: true });
      Meteor.call("newApiToken", { identityId: currentGrain.identityId() }, grainId,
                  event.target.getElementsByClassName("label")[0].value,
                  assignment, { webkey: { forSharing: true } },
                  function (error, result) {
        if (error) {
          console.error(error.stack);
        } else {
          result.url = getOrigin() + "/shared/" + result.token;
          instance.completionState.set({ success: result });
          // On the next render, .copy-me will exist, and we should focus it then.
          Meteor.defer(function () {
            const element = instance.find(".copy-me");
            element.focus();
            selectElementContents(element);
          });
        }
      });
    },

    "click .reset-share-token": function (event, instance) {
      instance.completionState.set({ clear: true });
      instance.find("form").reset();
      instance.find("form option[data-default-selected=true]").selected = true;
    },
  });

  Template.grainPowerboxOfferPopup.events({
    "click button.dismiss": function (event) {
      const data = Template.instance().data.get();
      data.onDismiss();
    },

    "click .copy-me": selectTargetContents,
    "focus .copy-me": selectTargetContents,
  });

  Template.grainSharePopup.helpers({
    incognito: function () {
      return !Accounts.getCurrentIdentityId();
    },

    currentTokenUrl: function () {
      return getOrigin() + "/shared/" + getActiveGrain(globalGrains.get()).token();
    },

    currentGrain: function () {
      return getActiveGrain(globalGrains.get());
    },
  });

  Template.grainView.helpers({
    unpackedGrainState: function () {
      return mapGrainStateToTemplateData(this);
    },

    identityPickerData: function () {
      const identities = SandstormDb.getUserIdentityIds(Meteor.user()).map(function (id) {
        const identity = Meteor.users.findOne({ _id: id });
        if (identity) {
          SandstormDb.fillInProfileDefaults(identity);
          SandstormDb.fillInIntrinsicName(identity);
          SandstormDb.fillInPictureUrl(identity);
          return identity;
        }
      });

      const grain = getActiveGrain(globalGrains.get());
      return { identities: identities,
              onPicked: function (identityId) { grain.revealIdentity(identityId); }, };
    },
  });

  Template.grain.helpers({
    currentGrain: function () {
      return getActiveGrain(globalGrains.get());
    },

    isOwner: function () {
      const current = getActiveGrain(globalGrains.get());
      return current && current.isOwner();
    },

    grainSize: function () {
      const current = getActiveGrain(globalGrains.get());
      const sizeBytes = current && current.size();
      if (sizeBytes !== undefined) {
        return "(" + prettySize(sizeBytes) + ")";
      } else {
        return "";
      }
    },

    setGrainWindowTitle:  function () {
      const current = getActiveGrain(globalGrains.get());
      if (current) {
        current.updateDocumentTitle();
      }
    },

    displayWebkeyButton: function () {
      // TODO: figure out what this should do
      return Meteor.userId() || !this.oldSharingModel;
    },

    showPowerboxOffer: function () {
      const current = getActiveGrain(globalGrains.get());
      return current && current.showPowerboxOffer();
    },

    powerboxOfferData: function () {
      const current = getActiveGrain(globalGrains.get());
      return current && current.powerboxOfferData();
    },

    showPowerboxRequest: function () {
      const current = getActiveGrain(globalGrains.get());
      return current && current.showPowerboxRequest();
    },

    powerboxRequestData: function () {
      const current = getActiveGrain(globalGrains.get());
      return current && current.powerboxRequestData();
    },

    cancelPowerboxRequest: function () {
      return () => {
        const current = getActiveGrain(globalGrains.get());
        current.setPowerboxRequest(undefined);
        return "remove";
      };
    },
  });

  Template.grainTitle.helpers({
    title: function () {
      const grain = getActiveGrain(globalGrains.get());
      return (grain && grain.title()) || "Untitled grain";
    },
  });

  Template.grainApiTokenPopup.helpers({
    displayToken: function () {
      return !this.revoked && !this.expiresIfUnused && !this.parentToken;
    },

    existingTokens: function () {
      const current = getActiveGrain(globalGrains.get());
      return current && ApiTokens.find({
        grainId: current.grainId(),
        identityId: current.identityId(),
        forSharing: { $ne: true },
        $or: [
          { owner: { webkey: null } },
          { owner: { $exists: false } },
        ],
        expiresIfUnused: null,
      });
    },

    generatedApiToken: function () {
      const current = getActiveGrain(globalGrains.get());
      return current && current.generatedApiToken();
    },

    generatedApiTokenPending: function () {
      const current = getActiveGrain(globalGrains.get());
      return (current && current.generatedApiToken()) == "pending";
    },

    viewInfo: function () {
      const current = getActiveGrain(globalGrains.get());
      return current && current.viewInfo();
    },
  });

  Template.whoHasAccessPopup.onCreated(function () {
    const _this = this;
    this.subscribe("contactProfiles");
    const currentGrain = getActiveGrain(globalGrains.get());
    _this.identityId = currentGrain.identityId();
    _this.grainId = currentGrain.grainId();
    _this.transitiveShares = new ReactiveVar(null);
    _this.downstreamTokensById = new ReactiveVar({});
    this.resetTransitiveShares = function () {
      Meteor.call("transitiveShares", _this.identityId, _this.grainId,
                  function (error, downstream) {
        if (error) {
          console.error(error.stack);
        } else {
          const downstreamTokensById = {};
          const sharesByRecipient = {};
          downstream.forEach(function (token) {
            downstreamTokensById[token._id] = token;
            if (Match.test(token.owner, { user: Match.ObjectIncluding({ identityId: String }) })) {
              const recipient = token.owner.user.identityId;
              if (!sharesByRecipient[recipient]) {
                sharesByRecipient[recipient] = {
                  recipient: recipient,
                  dedupedShares: [],
                  allShares: [],
                };
              }

              sharesByRecipient[recipient].allShares.push(token);
              const dedupedShares = sharesByRecipient[recipient].dedupedShares;
              if (!dedupedShares.some((share) => share.identityId === token.identityId)) {
                dedupedShares.push(token);
              }
            }
          });

          let result = _.values(sharesByRecipient);
          if (result.length == 0) {
            result = { empty: true };
          }

          _this.transitiveShares.set(result);
          _this.downstreamTokensById.set(downstreamTokensById);
        }
      });
    };

    this.resetTransitiveShares();
  });

  Template.whoHasAccessPopup.events({
    "change .share-token-role": function (event, instance) {
      const roleList = event.target;
      let assignment;
      if (roleList) {
        assignment = { roleId: roleList.selectedIndex };
      } else {
        assignment = { none: null };
      }

      Meteor.call("updateApiToken", roleList.getAttribute("data-token-id"),
                  { roleAssignment: assignment }, function (error) {
        if (error) {
          console.error(error.stack);
        }
      });
    },

    "click button.revoke-token": function (event, instance) {
      Meteor.call("updateApiToken", event.currentTarget.getAttribute("data-token-id"),
                  { revoked: true });
      instance.resetTransitiveShares();
    },

    "click button.revoke-access": function (event, instance) {
      const recipient = event.currentTarget.getAttribute("data-recipient");
      const transitiveShares = instance.transitiveShares.get();
      const tokensById = instance.downstreamTokensById.get();
      const recipientShares = _.findWhere(transitiveShares, { recipient: recipient });
      const currentIdentityId = Accounts.getCurrentIdentityId();
      const recipientTokens = _.where(recipientShares.allShares, { identityId: currentIdentityId });

      // Two cases:
      // 1. All of the tokens are direct shares. Easy. Just revoke them.
      // 2. Some of the links are child tokens. For each, we walk up the chain of parents to the
      //    root. Then we walk downwards to see whether any other identities would be immediately
      //    affected by revoking those roots. We then collect that data and display it in a
      //    confirmation dialog.

      let directTokens = [];
      // Direct shares from the current identity to the recipient.

      let rootTokens = [];
      // Roots of chains of child tokens starting at the current identity and leading to the
      // recipient.

      recipientTokens.forEach((token) => {
        if (token.parentToken) {
          let currentToken = token;
          do {
            currentToken = tokensById[token.parentToken];
          } while (currentToken.parentToken);

          rootTokens.push(currentToken);
        } else {
          directTokens.push(token);
        }
      });

      if (rootTokens.length > 0) {
        // Some of the shares are not direct.

        let tokensByParent = {};
        for (let id in tokensById) {
          let token = tokensById[id];
          if (token.parentToken) {
            if (!tokensByParent[token.parentToken]) {
              tokensByParent[token.parentToken] = [];
            }

            tokensByParent[token.parentToken].push(token);
          }
        }

        let otherAffectedIdentities = {};
        let tokenStack = rootTokens.slice(0);
        while (tokenStack.length > 0) {
          let current = tokenStack.pop();
          if (Match.test(current.owner,
                         { user: Match.ObjectIncluding({ identityId: String }) })) {
            if (current.owner.user.identityId != recipient) {
              otherAffectedIdentities[current.owner.user.identityId] = true;
            }
          } else {
            if (tokensByParent[current._id]) {
              let children = tokensByParent[current._id];
              children.forEach(child => {
                tokenStack.push(child);
              });
            }
          }
        }

        const recipientIdentity = ContactProfiles.findOne({ _id: recipient });
        const recipientName = (recipientIdentity && recipientIdentity.profile.name) ||
            "Unknown User";
        const singular = rootTokens.length == 1;

        const tokenLabels = _.pluck(rootTokens, "petname")
            .map(petname => petname || "Unlabeled Link")
            .map(petname => "\"" + petname + "\"")
            .join(", ");

        let confirmText = "This will revoke the following sharing link" + (singular ? "" : "s") +
            ":\n\n    " + tokenLabels + "\n\n";

        let othersNote = "(No signed-in user other than " + recipientName + " has opened " +
            (singular ? "this link" : "these links") + " yet.)";
        if (Object.keys(otherAffectedIdentities).length > 0) {
          const othersNames = Object.keys(otherAffectedIdentities)
              .map(identityId => ContactProfiles.findOne({ _id: identityId }))
              .map(identity => (identity && identity.profile.name) || "Unknown User")
              .join(", ");
          othersNote = (singular ? "This link has" : "These links have") +
            " also been opened by:\n\n    " + othersNames;
        }

        if (window.confirm(confirmText + othersNote)) {
          rootTokens.forEach((token) => {
            Meteor.call("updateApiToken", token._id, { revoked: true });
          });
        } else {
          // Cancel.
          return;
        }
      }

      directTokens.forEach((token) => {
        Meteor.call("updateApiToken", token._id, { revoked: true });
      });

      instance.resetTransitiveShares();
    },

    "click .token-petname": function (event, instance) {
      // TODO(soon): Find a less-annoying way to get this input, perhaps by allowing the user
      //   to edit the petname in place.
      const petname = window.prompt("Set new label:", this.petname);
      if (petname) {
        Meteor.call("updateApiToken", event.currentTarget.getAttribute("data-token-id"),
                    { petname: petname });
      }

      instance.resetTransitiveShares();
    },
  });

  function isEmptyPermissionSet(permissionSet) {
    if (!permissionSet) {
      return true;
    }

    for (let ii = 0; ii < permissionSet.length; ++ii) {
      if (permissionSet[ii]) {
        return false;
      }
    }

    return true;
  }

  Template.whoHasAccessPopup.helpers({
    existingShareTokens: function () {
      if (Meteor.userId()) {
        return ApiTokens.find({
          grainId: Template.instance().grainId,
          identityId: Template.instance().identityId,
          forSharing: true,
          $or: [
            { owner: { webkey:null } },
            { owner: { $exists: false } },
          ],
        }).fetch();
      }
    },

    isCurrentIdentity: function () {
      if (this.identityId === Accounts.getCurrentIdentityId()) {
        return true;
      }
    },

    getPetname: function () {
      if (this.petname) {
        return this.petname;
      } else {
        return "Unlabeled Link";
      }
    },

    displayName: function (identityId) {
      let identity = ContactProfiles.findOne({ _id: identityId });
      if (!identity) {
        identity = Meteor.users.findOne({ _id: identityId });
      }

      if (identity) {
        return identity.profile.name;
      } else {
        return "Unknown User (" + identityId.slice(0, 16) + ")";
      }
    },

    transitiveShares: function () {
      return Template.instance().transitiveShares.get();
    },

    indexedRoles: function () {
      const result = [];
      const instance = Template.instance();
      const currentGrain = getActiveGrain(globalGrains.get());
      const roles = currentGrain.viewInfo().roles;
      for (let ii = 0; ii < roles.length; ++ii) {
        result.push({ idx: ii, title: roles[ii].title, verbPhrase: roles[ii].verbPhrase });
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

    hasCustomRole: function (token) {
      const role = token.roleAssignment;
      if ("roleId" in role &&
          isEmptyPermissionSet(role.addPermissions) &&
          isEmptyPermissionSet(role.removePermissions)) {
        return false;
      }

      return true;
    },

    hasCurrentRole: function (token) {
      const role = token.roleAssignment;
      if ("roleId" in role && role.roleId == this.idx &&
          isEmptyPermissionSet(role.addPermissions) &&
          isEmptyPermissionSet(role.removePermissions)) {
        return true;
      }

      return false;
    },

    displayToken: function () {
      return !this.revoked && !this.expiresIfUnused && !this.parentToken;
    },

    viewInfo: function () {
      const activeGrain = getActiveGrain(globalGrains.get());
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

  Template.shareableLinkTab.onCreated(function () {
    this.completionState = new ReactiveVar({ clear: true });
  });

  Template.emailInviteTab.onCreated(function () {
    this.completionState = new ReactiveVar({ clear: true });
    this.contacts = new ReactiveVar([]);
  });

  Template.shareableLinkTab.helpers({
    completionState: function () {
      const instance = Template.instance();
      return instance.completionState.get();
    },
  });
  Template.emailInviteTab.helpers({
    completionState: function () {
      const instance = Template.instance();
      return instance.completionState.get();
    },

    contacts: function () {
      return Template.instance().contacts;
    },
  });

  Template.emailInviteTab.events({
    "submit form.email-invite": function (event, instance) {
      event.preventDefault();
      return false;
    },

    "click form.email-invite button": function (event, instance) {
      event.preventDefault();
      if (!instance.completionState.get().clear) {
        return;
      }

      const grainId = instance.data.grainId;
      const title = instance.data.title;

      const roleList = instance.find(".share-token-role");
      let assignment;
      if (roleList) {
        assignment = { roleId: roleList.selectedIndex };
      } else {
        assignment = { none: null };
      }

      const message = instance.find(".personal-message").value;
      instance.completionState.set({ pending: true });

      const currentGrain = getActiveGrain(globalGrains.get());

      // HTML-escape the message.
      const div = document.createElement("div");
      div.appendChild(document.createTextNode(message));
      const htmlMessage = div.innerHTML.replace(/\n/g, "<br>");

      const contacts = instance.contacts.get();
      const emails = instance.find("input.emails");
      const emailsValue = emails.value;
      if (emailsValue) {
        if (emailsValue.match(/.+\@.+\..+/)) {
          contacts.push({
            _id: emailsValue,
            profile: {
              service: "email",
              name: emailsValue,
              intrinsicName: emailsValue,
              pictureUrl: "/email.svg",
            },
            isDefault: true,
          });
          instance.contacts.set(contacts);
          emails.value = "";
        } else {
          instance.completionState.set(
            { error: "Invalid text in contact input box: " + emailsValue });
          return;
        }
      }

      Meteor.call("inviteUsersToGrain", getOrigin(), currentGrain.identityId(),
                  grainId, title, assignment, contacts,
                  { text: message, html: htmlMessage }, function (error, result) {
        if (error) {
          instance.completionState.set({ error: error.toString() });
        } else {
          if (result.failures.length > 0) {
            let message = "Failed to send to: ";
            for (let ii = 0; ii < result.failures.length; ++ii) {
              console.error(result.failures[ii].error);
              if (ii != 0) {
                message += ", ";
              }

              message += result.failures[ii].contact.profile.name;
              const warning = result.failures[ii].warning;
              if (warning) {
                message += ". " + warning;
              }
            }

            instance.completionState.set({ error: message });
          } else {
            instance.completionState.set({ success: "success" });
          }
        }
      });
    },

    "click .reset-invite": function (event, instance) {
      instance.contacts.set([]);
      instance.completionState.set({ clear: true });
      instance.find("form").reset();
      instance.find("form option[data-default-selected=true]").selected = true;
    },

    "click .start-over-invite": function (event, instance) {
      instance.completionState.set({ clear: true });
    },
  });

  Template.grainPowerboxOfferPopup.helpers({
    powerboxOfferUrl: function () {
      const offer = Template.instance().data.get().offer;
      return offer && offer.url;
    },
  });

  // Send a keep-alive for each grain every now and then.
  Meteor.setInterval(function () {
    const grains = globalGrains.get();
    if (!grains) return;

    // Meteor has an exponential backoff of up to 5 minutes for reconnect. This is unnacceptable
    // for us, since we rely on Sessions being re-established in under 60s.
    if (Meteor.status().status === "waiting") {
      console.log("Sandstorm is trying to reconnect...");
      Meteor.reconnect();
    }

    grains.forEach(function (grain) {
      if (grain.sessionId()) {
        // TODO(soon):  Investigate what happens in background tabs.  Maybe arrange to re-open the
        //   app if it dies while in the background.
        Meteor.call("keepSessionAlive", grain.sessionId(), function (error, result) {
          // Sessions will automatically resume if possible, otherwise they will refresh.
        });
      }
    });
  }, 60000);

  // Message handler for Sandstorm's client-side postMessage API.
  Meteor.startup(function () {
    const messageListener = function (event) {
      if (event.origin === getOrigin()) {
        // Meteor likes to postMessage() to itself sometimes, so we ignore these messages.
        return;
      }

      // Look up the grain index of which grain this postmessage came from, so we can map behavior
      // into that particular grain's state
      const grains = globalGrains.get();
      const senderGrainIndex = grainOriginToIndex(grains, event.origin);
      if (senderGrainIndex == -1) {
        // We got a postMessage from an origin that is not a grain we currently believe is open.
        // Ignore it. (It may be aimed at some other message listener registered elsewhere...)
        return;
      }

      const senderGrain = grains[senderGrainIndex];

      if (event.data.setPath || event.data.setPath === "") {
        const path = event.data.setPath || "/";
        check(path, String);
        check(path.charAt(0), "/");
        // TODO(security): More sanitization of this path. E.g. reject "/../../".
        senderGrain.setPath(path);
      } else if (event.data.startSharing) {
        // Allow the current grain to request that the "Share Access" menu be shown.
        // Only show this popup if no other popup is currently active.
        // TODO(security): defend against malicious apps spamming this call, blocking all other UI.
        const currentGrain = getActiveGrain(globalGrains.get());
        if (senderGrain === currentGrain && !globalTopbar.isPopupOpen()) {
          globalTopbar.openPopup("share");
        }
      } else if (event.data.setTitle || event.data.setTitle === "") {
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
        const call = event.data.renderTemplate;
        check(call, Object);
        const rpcId = call.rpcId;
        try {
          check(call, { rpcId: String, template: String, petname: Match.Optional(String),
                       roleAssignment: Match.Optional(roleAssignmentPattern),
                       forSharing: Match.Optional(Boolean), });
        } catch (error) {
          event.source.postMessage({ rpcId: rpcId, error: error.toString() }, event.origin);
          return;
        }

        const template = call.template;
        let petname = "connected external app";
        if (call.petname) {
          petname = call.petname;
        }

        let assignment = { allAccess: null };
        if (call.roleAssignment) {
          assignment = call.roleAssignment;
        }

        const forSharing = call.forSharing ? call.forSharing : false;
        // Tokens expire by default in 5 minutes from generation date
        const selfDestructDuration = 5 * 60 * 1000;

        let provider;
        if (Router.current().route.getName() === "shared") {
          provider = { rawParentToken: Router.current().params.token };
        } else {
          provider = { identityId: senderGrain.identityId() };
        }

        const owner = {
          webkey: {
            forSharing: forSharing,
            expiresIfUnusedDuration: selfDestructDuration,
          },
        };

        Meteor.call("newApiToken", provider, senderGrain.grainId(), petname, assignment, owner,
                    function (error, result) {
          if (error) {
            event.source.postMessage({ rpcId: rpcId, error: error.toString() }, event.origin);
          } else {
            const tokenId = result.token;
            // Generate random key id2.
            const id2 = Random.secret();
            // Store apitoken id1 and template in session storage in the offer
            // template namespace under key id2.
            const key = "offerTemplate" + id2;
            const host = globalDb.makeApiHost(tokenId);
            const renderedTemplate = template.replace(/\$API_TOKEN/g, tokenId)
                                             .replace(/\$API_HOST/g, host);
            sessionStorage.setItem(key, JSON.stringify({
                token: tokenId,
                renderedTemplate: renderedTemplate,
                expires: Date.now() + selfDestructDuration,
              })
            );
            sessionStorage.setItem(key + "-host", host);

            // Send message to event.source with URL containing id2
            templateLink = window.location.origin + "/offer-template.html#" + id2;
            event.source.postMessage({ rpcId: rpcId, uri: templateLink }, event.origin);
          }
        });
      } else if (event.data.powerboxRequest) {
        const powerboxRequest = event.data.powerboxRequest;
        check(powerboxRequest, {
          // TODO: be more strict, and check more fields, once the test apps are more conformant
          rpcId: Match.Any,
          query: Match.Optional([Object]), // TODO: be more precise, and also make non-optional once tests are updated to provide a query
          saveLabel: Match.Optional(String),
        });

        const powerboxRequestInfo = {
          source: event.source,
          origin: event.origin,
          // We'll need these to post a reply message

          rpcId: powerboxRequest.rpcId,
          query: powerboxRequest.query,
          saveLabel: powerboxRequest.saveLabel,
          // These data come from the grain

          sessionId: senderGrain.sessionId(),
          grainId: senderGrain.grainId(),
          identityId: senderGrain.identityId(),
          // Attach grain context to the request.

          onCompleted: function () { globalTopbar.closePopup(); },
          // Allow the grain to close the popup when we've completed the request.
        };
        const requestContext = new SandstormPowerboxRequest(globalDb, powerboxRequestInfo);
        senderGrain.setPowerboxRequest(requestContext);
        globalTopbar.openPopup("request");
      } else {
        console.log("postMessage from app not understood: ", event.data);
        console.log(event);
      }
    };

    window.addEventListener("message", messageListener, false);
  });
}

if (Meteor.isClient) {
  function maybeScrollLog() {
    const elem = document.getElementById("grainLog");
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
        const elem2 = document.getElementById("grainLog");
        if (elem2) scrollLogToBottom(elem2);
      });
    }
  }

  function scrollLogToBottom(elem) {
    elem.scrollTop = elem.scrollHeight;
  }
}

function makeGrainIdActive(grainId) {
  const grains = globalGrains.get();
  for (let i = 0; i < grains.length; i++) {
    const grain = grains[i];
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
  const idx = activeGrainIndex(grains);
  return idx == -1 ? undefined : grains[idx];
}

function activeGrainIndex(grains) {
  for (let i = 0; i < grains.length; i++) {
    if (grains[i].isActive()) {
      return i;
    }
  }

  return -1;
}

function grainOriginToIndex(grains, origin) {
  for (let i = 0; i < grains.length; i++) {
    if (grains[i].origin() === origin) {
      return i;
    }
  }

  return -1;
}

function grainIdToIndex(grains, grainId) {
  for (let i = 0; i < grains.length; i++) {
    const grain = grains[i];
    if (grains[i].grainId() === grainId) {
      return i;
    }
  }

  return -1;
}

function mapGrainStateToTemplateData(grainState) {
  const templateData = {
    grainId: grainState.grainId(),
    active: grainState.isActive(),
    title: grainState.title(),
    error: grainState.error(),
    appOrigin: grainState.origin(),
    hasNotLoaded: !(grainState.hasLoaded()),
    sessionId: grainState.sessionId(),
    originalPath: grainState._originalPath,
    interstitial: grainState.shouldShowInterstitial(),
    token: grainState.token(),
    viewInfo: grainState.viewInfo(),
  };
  return templateData;
}

GrainLog = new Mongo.Collection("grainLog");
// Pseudo-collection created by subscribing to "grainLog", implemented in proxy.js.

Router.map(function () {
  this.route("apps", {
    path: "/apps",
    waitOn: function () { return globalSubs; },

    data: function () {
      if (!this.ready()) return;
      if (!Meteor.userId() && !Meteor.loggingIn()) {
        Router.go("root", {}, { replaceState: true });
      }

      return new SandstormAppList(globalDb, globalQuotaEnforcer);
    },
  });
  this.route("newGrainRedirect", {
    // The path /grain/new used to be where you would go to create new grains.
    // Its functionality has been superceded by the apps route, so redirect in
    // case anyone has the old link saved somewhere.
    path: "/grain/new",
    onBeforeAction: function () {
      Router.go("apps", {}, { replaceState: true });
    },
  });
  this.route("grains", {
    path: "/grain",
    waitOn: function () { return globalSubs; },

    data: function () {
      if (!this.ready()) return;
      if (!Meteor.userId() && !Meteor.loggingIn()) {
        Router.go("root", {}, { replaceState: true });
      }

      return new SandstormGrainListPage(globalDb, globalQuotaEnforcer);
    },
  });
  this.route("grain", {
    path: "/grain/:grainId/:path(.*)?",
    loadingTemplate: "loadingNoMessage",

    waitOn: function () {
      return globalSubs;
    },

    onBeforeAction: function () {
      // Run this hook only once.
      if (this.state.get("beforeActionHookRan")) { return this.next(); }

      this.state.set("beforeActionHookRan", true);
      const grainId = this.params.grainId;
      const path = "/" + (this.params.path || "") + (this.originalUrl.match(/[#?].*$/) || "");
      const grains = globalGrains.get();
      let grainIndex = grainIdToIndex(grains, grainId);
      if (grainIndex == -1) {
        // The element we need to attach our Blaze view to may not exist yet.
        // In that case, defer creating the GrainView until we're sure it's
        // had a chance to render.
        const openView = function openView() {
          const mainContentElement = document.querySelector("body>.main-content");
          if (mainContentElement) {
            const grains = globalGrains.get();
            const grainToOpen = new GrainView(grainId, path, undefined, mainContentElement);
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
    },
  });

  this.route("/shared/:token/:path(.*)?", {
    name: "shared",
    template: "grain",
    loadingTemplate: "loadingNoMessage",

    waitOn: function () {
      return [
        Meteor.subscribe("devPackages"),
        Meteor.subscribe("tokenInfo", this.params.token),

        Meteor.subscribe("grainsMenu"),
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

      const token = this.params.token;
      const path = "/" + (this.params.path || "") + (this.originalUrl.match(/[#?].*$/) || "");
      const hash = this.params.hash;

      const tokenInfo = TokenInfo.findOne({ _id: token });
      if (tokenInfo && tokenInfo.invalidToken) {
        this.state.set("invalidToken", true);
      } else {
        const grainId = tokenInfo.grainId;
        const grains = globalGrains.get();
        let grainIndex = grainIdToIndex(grains, grainId);
        if (grainIndex == -1) {
          const openView = function openView() {
            const mainContentElement = document.querySelector("body>.main-content");
            if (mainContentElement) {
              const grains = globalGrains.get();
              const grainToOpen = new GrainView(grainId, path, tokenInfo, mainContentElement);
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
      }

      this.next();
    },

    action: function () {
      if (this.state.get("invalidToken")) {
        this.render("invalidToken", { data: { token: this.params.token } });
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
    },
  });

  this.route("grainLog", {
    path: "/grainlog/:grainId",
    layoutTemplate: "noLayout",

    waitOn: function () {
      return [
        Meteor.subscribe("grainTopBar", this.params.grainId),
        Meteor.subscribe("grainLog", this.params.grainId),
      ];
    },

    data: function () {
      if (this.ready()) {
        maybeScrollLog();
        const grain = Grains.findOne(this.params.grainId);
        return {
          title: grain ? grain.title : "(deleted grain)",
          // jscs:disable requireCamelCaseOrUpperCaseIdentifiers
          html: AnsiUp.ansi_to_html(GrainLog.find({}, { $sort: { _id: 1 } })
              .map(function (entry) { return entry.text; })
              .join(""), { use_classes:true }),
          // jscs:enable requireCamelCaseOrUpperCaseIdentifiers
        };
      }
    },
  });

  this.route("appDetails", {
    path: "/apps/:appId",
    template: "appDetails",
    waitOn: function () {
      return globalSubs.concat(
        Meteor.subscribe("appIndex", this.params.appId));
    },

    data: function () {
      return new SandstormAppDetails(globalDb, globalQuotaEnforcer, this.params.appId);
    },
  });
});

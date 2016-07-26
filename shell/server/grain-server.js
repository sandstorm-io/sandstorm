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

const Crypto = Npm.require("crypto");
import { send as sendEmail } from "/imports/server/email.js";

const emailLinkWithInlineStyle = function (url, text) {
  return "<a href='" + url + "' style='display:inline-block;text-decoration:none;" +
   "font-family:sans-serif;width:200px;min-height:30px;line-height:30px;" +
   "border-radius:4px;text-align:center;background:#762F87;color:white'>" +
   text + "</a>";
};

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
      identityId: 1,
      owner: 1,
      revoked: 1,
    },
  });
  if (!apiToken) {
    this.added("tokenInfo", token, { invalidToken: true });
  } else if (apiToken.revoked) {
    this.added("tokenInfo", token, { revoked: true });
  } else {
    const grainId = apiToken.grainId;
    const grain = Grains.findOne({
      _id: grainId,
    }, {
      fields: {
        packageId: 1,
        appId: 1,
        userId: 1,
      },
    });
    if (!grain) {
      this.added("tokenInfo", token, { invalidToken: true });
    } else {
      if (apiToken.owner && apiToken.owner.user) {
        let identity = globalDb.getIdentity(apiToken.owner.user.identityId);
        let metadata = apiToken.owner.user.denormalizedGrainMetadata;
        if (identity && metadata) {
          SandstormDb.fillInLoginId(identity);
          this.added("tokenInfo", token, {
            identityOwner: _.pick(identity, "_id", "profile", "loginId"),
            grainId: grainId,
            grainMetadata: metadata,
          });
        } else {
          this.added("tokenInfo", token, { invalidToken: true });
        }
      } else if (!apiToken.owner || "webkey" in apiToken.owner) {
        if (this.userId) {
          const user = Meteor.users.findOne({ _id: this.userId });
          const identityIds = SandstormDb.getUserIdentityIds(user);
          const childToken = ApiTokens.findOne({
            "owner.user.identityId": { $in: identityIds },
            parentToken: apiToken._id,
          });
          if (childToken || this.userId === grain.userId ||
              identityIds.indexOf(apiToken.identityId) >= 0) {
            this.added("tokenInfo", token, { alreadyRedeemed: true, grainId: apiToken.grainId, });
            this.ready();
            return;
          }
        }

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
        this.added("tokenInfo", token, {
          webkey: true,
          grainId: grainId,
          grainMetadata: denormalizedGrainMetadata,
        });
      } else {
        this.added("tokenInfo", token, { invalidToken: true });
      }
    }
  }

  this.ready();
  return;
});

Meteor.publish("requestingAccess", function (grainId) {
  check(grainId, String);

  if (!this.userId) {
    throw new Meteor.Error(403, "Must be logged in to request access.");
  }

  const grain = globalDb.getGrain(grainId);
  if (!grain) {
    throw new Meteor.Error(404, "Grain not found.");
  }

  if (grain.userId === this.userId) {
    this.added("grantedAccessRequests",
               Random.id(), { grainId: grainId, identityId: grain.identityId });
  }

  const identityIds = SandstormDb.getUserIdentityIds(Meteor.users.findOne({ _id: this.userId }));
  const ownerIdentityIds = SandstormDb.getUserIdentityIds(
      Meteor.users.findOne({ _id: grain.userId }));

  const _this = this;
  const query = ApiTokens.find({
    grainId: grainId,
    identityId: { $in: ownerIdentityIds },
    parentToken: { $exists: false },
    "owner.user.identityId": { $in: identityIds },
    revoked: { $ne: true },
  });
  const handle = query.observe({
    added(apiToken) {
      _this.added("grantedAccessRequests",
                  Random.id(), { grainId: grainId, identityId: apiToken.owner.user.identityId });
    },
  });

  this.onStop(() => handle.stop());
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

const GRAIN_DELETION_MS = 1000 * 60 * 60 * 24 * 30; // thirty days
SandstormDb.periodicCleanup(86400000, () => {
  const trashExpiration = new Date(Date.now() - GRAIN_DELETION_MS);
  globalDb.removeApiTokens({ trashed: { $lt: trashExpiration } });
  globalDb.deleteGrains({ trashed: { $lt: trashExpiration } }, globalBackend, "grain");
});

Meteor.methods({
  moveGrainsToTrash: function (grainIds) {
    check(grainIds, [String]);

    if (this.userId) {
      Grains.update({ userId: { $eq: this.userId },
                      _id: { $in: grainIds },
                      trashed: { $exists: false }, },
                    { $set: { trashed: new Date() } },
                    { multi: true });

      const identityIds = SandstormDb.getUserIdentityIds(Meteor.user());

      ApiTokens.update({ grainId: { $in: grainIds },
                        "owner.user.identityId": { $in: identityIds },
                        trashed: { $exists: false }, },
                       { $set: { "trashed": new Date() } },
                       { multi: true });
    }
  },

  moveGrainsOutOfTrash: function (grainIds) {
    check(grainIds, [String]);

    if (this.userId) {
      Grains.update({ userId: { $eq: this.userId },
                      _id: { $in: grainIds },
                      trashed: { $exists: true }, },
                    { $unset: { trashed: 1 } },
                    { multi: true });

      const identityIds = SandstormDb.getUserIdentityIds(Meteor.user());

      ApiTokens.update({ grainId: { $in: grainIds },
                        "owner.user.identityId": { $in: identityIds },
                        "trashed": { $exists: true }, },
                       { $unset: { "trashed": 1 } },
                       { multi: true });
    }
  },

  deleteGrain: function (grainId) {
    check(grainId, String);

    if (this.userId) {
      const query = {
        _id: grainId,
        userId: this.userId,
        trashed: { $exists: true },
      };
      const numDeleted = globalDb.deleteGrains(query, globalBackend,
                                               isDemoUser() ? "demoGrain" : "grain");

      // Usually we don't automatically remove user-owned tokens that have become invalid,
      // because if we did their owner might become confused as to why they have mysteriously
      // disappeared. In this particular case, however, for tokens held by the grain owner,
      // there should be no confusion. Indeed, it would be more confusing *not* to remove these
      // tokens, because then the grain could still show up in the trash bin as a "shared with me"
      // grain after the owner clicks "delete permanently".
      //
      // Note that these tokens may be visible to other accounts if there are identities shared
      // between the accounts; by only removing 'trashed' tokens, we minimize confusion in that
      // case too.
      if (numDeleted > 0) {
        globalDb.removeApiTokens({
          grainId: grainId,
          "owner.user.identityId": { $in: SandstormDb.getUserIdentityIds(Meteor.user()) },
          "trashed": { $exists: true },
        });
      }
    }
  },

  forgetGrain: function (grainId, identityId) {
    check(grainId, String);
    check(identityId, String);

    if (!this.userId) {
      throw new Meteor.Error(403, "Must be logged in to forget a grain.");
    }

    if (!globalDb.userHasIdentity(this.userId, identityId)) {
      throw new Meteor.Error(403, "Current user does not have the identity " + identityId);
    }

    globalDb.removeApiTokens({ grainId: grainId,
                              "owner.user.identityId": identityId,
                              "trashed": { $exists: true },
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

          // Denormalize new title out to all sharing tokens.
          ApiTokens.update({ grainId: grainId, "owner.user": { $exists: true } },
                           { $set: { "owner.user.upstreamTitle": newTitle } },
                           { multi: true });
        } else {
          if (!globalDb.userHasIdentity(this.userId, identityId)) {
            throw new Meteor.Error(403, "Current user does not have identity " + identityId);
          }

          const token = ApiTokens.findOne({
            grainId: grainId,
            objectId: { $exists: false },
            "owner.user.identityId": identityId,
          }, {
            sort: { created: 1 }, // The oldest token is our source of truth for the name.
          });
          if (token && token.owner.user.title !== newTitle) {
            if (token.owner.user.upstreamTitle === newTitle) {
              // User renamed grain to match upstream title. Act like they never renamed it at
              // all.
              ApiTokens.update({
                grainId: grainId,
                "owner.user.identityId": identityId,
              }, {
                $set: { "owner.user.title": newTitle },
                $unset: { "owner.user.upstreamTitle": 1, "owner.user.renamed": 1 },
              }, {
                multi: true,
              });
            } else {
              const modification = {
                "owner.user.title": newTitle,
                "owner.user.renamed": true,
              };

              if (!token.owner.user.upstreamTitle) {
                // If `upstreamTitle` isn't present then it is equal to the old title.
                modification["owner.user.upstreamTitle"] = token.owner.user.title;
              }

              ApiTokens.update({ grainId: grainId, "owner.user.identityId": identityId },
                               { $set: modification },
                               { multi: true });
            }
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

      if (globalDb.isDemoUser()) {
        throw new Meteor.Error(403, "Demo users are not allowed to share by email.");
      }

      const accountId = this.userId;
      const outerResult = { successes: [], failures: [] };
      const fromEmail = globalDb.getReturnAddressWithDisplayName(identityId);
      const replyTo = globalDb.getPrimaryEmail(accountId, identityId);
      contacts.forEach(function (contact) {
        if (contact.isDefault && contact.profile.service === "email") {
          const emailAddress = contact.profile.intrinsicName;
          const result = SandstormPermissions.createNewApiToken(
            globalDb, { identityId: identityId, accountId: accountId }, grainId,
            "email invitation for " + emailAddress,
            roleAssignment, { webkey: { forSharing: true } });
          const url = origin + "/shared/" + result.token;
          const html = message.html + "<br><br>" +
              emailLinkWithInlineStyle(url, "Open Shared Grain") +
              "<div style='font-size:8pt;font-style:italic;color:gray'>" +
              "Note: If you forward this email to other people, they will be able to access " +
              "the share as well. To prevent this, remove the button before forwarding.</div>";
          try {
            globalDb.incrementDailySentMailCount(accountId);
            sendEmail({
              to: emailAddress,
              from: fromEmail,
              replyTo: replyTo,
              subject: title + " - Invitation to collaborate",
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
          const url = origin + "/shared/" + result.token;
          try {
            const identity = Meteor.users.findOne({ _id: contact._id });
            const email = _.findWhere(SandstormDb.getVerifiedEmails(identity),
                                      { primary: true });
            if (email) {
              const intrinsicName = contact.profile.intrinsicName;
              let loginNote;
              if (contact.profile.service === "google") {
                loginNote = "Google account with address " + email.email;
              } else if (contact.profile.service === "github") {
                loginNote = "Github account with username " + intrinsicName;
              } else if (contact.profile.service === "email") {
                loginNote = "email address " + intrinsicName;
              } else if (contact.profile.service === "ldap") {
                loginNote = "LDAP username " + intrinsicName;
              } else if (contact.profile.service === "saml") {
                loginNote = "SAML ID " + intrinsicName;
              } else {
                throw new Meteor.Error(500, "Unknown service to email share link.");
              }

              const html = message.html + "<br><br>" +
                  emailLinkWithInlineStyle(url, "Open Shared Grain") +
                  "<div style='font-size:8pt;font-style:italic;color:gray'>" +
                  "Note: You will need to log in with your " + loginNote +
                  " to access this grain.";
              globalDb.incrementDailySentMailCount(accountId);
              sendEmail({
                to: email.email,
                from: fromEmail,
                replyTo: replyTo,
                subject: title + " - Invitation to collaborate",
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

  requestAccess: function (origin, grainId, identityId) {
    check(origin, String);
    check(grainId, String);
    check(identityId, String);
    if (!this.isSimulation) {
      if (!this.userId) {
        throw new Meteor.Error(403, "Must be logged in to request access.");
      }

      if (!globalDb.userHasIdentity(this.userId, identityId)) {
        throw new Meteor.Error(403, "Not an identity of the current user: " + identityId);
      }

      const grain = Grains.findOne(grainId);
      if (!grain) {
        throw new Meteor.Error(404, "No such grain");
      }

      const grainOwner = globalDb.getUser(grain.userId);
      const email = _.findWhere(SandstormDb.getUserEmails(grainOwner), { primary: true });
      if (!email) {
        throw new Meteor.Error("no email", "Grain owner has no email address.");
      }

      const emailAddress = email.email;

      const identity = globalDb.getIdentity(identityId);
      globalDb.addContact(grainOwner._id, identityId);

      const fromEmail = globalDb.getReturnAddressWithDisplayName(identityId);
      const replyTo = globalDb.getPrimaryEmail(Meteor.userId(), identityId);

      // TODO(soon): In the HTML version, we should display an identity card.
      let identityNote = "";
      if (identity.profile.service === "google") {
        identityNote = " (" + identity.privateIntrinsicName + ")";
      } else if (identity.profile.service === "github") {
        identityNote = " (" + identity.profile.intrinsicName + " on GitHub)";
      } else if (identity.profile.service === "email") {
        identityNote = " (" + identity.profile.intrinsicName + ")";
      } else if (identity.profile.service === "ldap") {
        identityNote = " (" + identity.profile.intrinsicName + " on LDAP)";
      } else if (identity.profile.service === "saml") {
        identityNote = " (" + identity.profile.intrinsicName + " on SAML)";
      }

      const message = identity.profile.name + identityNote +
            " is requesting access to your grain: " + grain.title + ".";

      const url = origin + "/share/" + grainId + "/" + identityId;

      let html = message + "<br><br>" +
          emailLinkWithInlineStyle(url, "Open Sharing Menu");

      const user = Meteor.user();
      const ACCESS_REQUEST_LIMIT = 10;
      let resetCount = true;
      if (user.accessRequests) {
        if (user.accessRequests.resetOn < new Date()) {
          Meteor.users.update({ _id: user._id }, { $unset: { accessRequests: 1 } });
        } else if (user.accessRequests.count >= ACCESS_REQUEST_LIMIT) {
          throw new Meteor.Error(403, "For spam control reasons, you are not allowed to make " +
                                 "more than " + ACCESS_REQUEST_LIMIT +
                                 " access requests per day.");
        } else {
          resetCount = false;
        }
      }

      let modifier = { $inc: { "accessRequests.count": 1 } };
      if (resetCount) {
        let tomorrow = new Date(Date.now() + 86400000);
        modifier.$set = { "accessRequests.resetOn": tomorrow };
      }

      Meteor.users.update({ _id: user._id }, modifier);

      sendEmail({
        to: emailAddress,
        from: fromEmail,
        replyTo: replyTo,
        subject: grain.title + " - Request for access",
        text: message + "\n\nFollow this link to share access:\n\n" + url,
        html: html,
      });
    }
  },
});

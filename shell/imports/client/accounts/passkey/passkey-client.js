import { Meteor } from "meteor/meteor";
import { Template } from "meteor/templating";
import { ReactiveVar } from "meteor/reactive-var";
import { Accounts } from "meteor/accounts-base";

import {
  startAuthentication,
  startRegistration,
  browserSupportsWebAuthn,
  WebAuthnError,
} from "@simplewebauthn/browser";

import { globalDb } from "/imports/db-deprecated";

const loginWithPasskey = function (callback) {
  Meteor.call("passkey.generateAuthenticationOptions", function (err, optionsJSON) {
    if (err) {
      callback(err);
      return;
    }

    startAuthentication({ optionsJSON }).then(function (authResponse) {
      Accounts.callLoginMethod({
        methodArguments: [{ passkey: authResponse }],
        userCallback: function (error) {
          if (error) {
            callback(error);
          } else {
            callback();
          }
        },
      });
    }).catch(function (err) {
      if (err instanceof WebAuthnError) {
        if (err.code === "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY" ||
            err.code === "ERROR_CEREMONY_ABORTED") {
          // User cancelled or NotAllowedError: silently restore UI
          return;
        }
      }
      callback(new Meteor.Error(403, "Something went wrong. Please try again."));
    });
  });
};

export { loginWithPasskey, browserSupportsWebAuthn };

// Login button template
Template.passkeyLoginForm.helpers({
  webAuthnSupported() {
    return browserSupportsWebAuthn();
  },

  loginProviderLabel() {
    return "with Passkey";
  },
});

Template.passkeyLoginForm.events({
  "click button.login.oneclick.passkey"(event, instance) {
    if (instance.data.linkingNewCredential) {
      sessionStorage.setItem("linkingCredentialLoginToken", Accounts._storedLoginToken());
    }

    const loginButtonsSession = Accounts._loginButtonsSession;
    loginButtonsSession.resetMessages();

    loginWithPasskey(function (err) {
      if (err) {
        loginButtonsSession.errorMessage(err.reason || "Unknown error");
      } else {
        // Close login overlays
        const grainviews = typeof globalGrains !== "undefined" ? globalGrains.getAll() : [];
        grainviews.forEach(function (grainview) {
          grainview.disableSigninOverlay();
        });
      }
    });
  },
});

// Account settings: passkey management
Template.passkeyManagement.onCreated(function () {
  this._passkeyError = new ReactiveVar(null);
  this._passkeySuccess = new ReactiveVar(null);
  this._renamingCredentialId = new ReactiveVar(null);
});

Template.passkeyManagement.helpers({
  passkeyEnabled() {
    return Accounts.loginServices.passkey && Accounts.loginServices.passkey.isEnabled();
  },

  passkeys() {
    const user = Meteor.user();
    if (!user || !user.loginCredentials) return [];

    const result = [];
    const renamingId = Template.instance()._renamingCredentialId.get();

    user.loginCredentials.forEach(function (cred) {
      const credUser = Meteor.users.findOne({ _id: cred.id });
      if (credUser && credUser.services && credUser.services.passkey) {
        (credUser.services.passkey.keys || []).forEach(function (key) {
          result.push({
            credentialId: key.credentialId,
            friendlyName: key.friendlyName,
            createdAt: key.createdAt,
            lastUsedAt: key.lastUsedAt,
            isRenaming: key.credentialId === renamingId,
          });
        });
      }
    });

    return result;
  },

  passkeyError() {
    return Template.instance()._passkeyError.get();
  },

  passkeySuccess() {
    return Template.instance()._passkeySuccess.get();
  },

  formatDate(date) {
    if (!date) return "";
    return new Date(date).toLocaleDateString();
  },
});

Template.passkeyManagement.events({
  "click button.passkey-add"(event, instance) {
    instance._passkeyError.set(null);
    instance._passkeySuccess.set(null);

    Meteor.call("passkey.generateRegistrationOptions", function (err, result) {
      if (err) {
        instance._passkeyError.set(err.reason || "Failed to start registration.");
        return;
      }

      const { options: optionsJSON, userHandle } = result;

      startRegistration({ optionsJSON }).then(function (attestationResponse) {
        // Prompt for friendly name after ceremony
        const friendlyName = prompt("Name this passkey (optional):");

        // Determine whether to use new user or existing user method
        const user = Meteor.user();
        let hasExistingPasskey = false;
        if (user && user.loginCredentials) {
          user.loginCredentials.forEach(function (cred) {
            const credUser = Meteor.users.findOne({ _id: cred.id });
            if (credUser && credUser.services && credUser.services.passkey) {
              hasExistingPasskey = true;
            }
          });
        }

        Meteor.call("passkey.verifyRegistration",
          attestationResponse, userHandle, friendlyName || null,
          function (err, result) {
            if (err) {
              instance._passkeyError.set(err.reason || "Registration failed.");
            } else {
              instance._passkeySuccess.set(
                "Passkey \"" + result.friendlyName + "\" registered successfully."
              );
            }
          }
        );
      }).catch(function (err) {
        if (err instanceof WebAuthnError) {
          if (err.code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED") {
            instance._passkeyError.set("This authenticator is already registered.");
            return;
          }
          if (err.code === "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY" ||
              err.code === "ERROR_CEREMONY_ABORTED") {
            return; // User cancelled
          }
        }
        instance._passkeyError.set("Something went wrong. Please try again.");
      });
    });
  },

  "click button.passkey-rename"(event, instance) {
    const credentialId = event.currentTarget.closest(".passkey-item").dataset.credentialId;
    instance._renamingCredentialId.set(credentialId);
  },

  "click button.passkey-rename-save"(event, instance) {
    const li = event.currentTarget.closest(".passkey-item");
    const credentialId = li.dataset.credentialId;
    const newName = li.querySelector(".passkey-rename-input").value;

    Meteor.call("passkey.rename", credentialId, newName, function (err) {
      if (err) {
        instance._passkeyError.set(err.reason || "Failed to rename.");
      } else {
        instance._renamingCredentialId.set(null);
      }
    });
  },

  "click button.passkey-rename-cancel"(event, instance) {
    instance._renamingCredentialId.set(null);
  },

  "click button.passkey-remove"(event, instance) {
    const credentialId = event.currentTarget.closest(".passkey-item").dataset.credentialId;

    if (!confirm("Remove this passkey? This cannot be undone.")) return;

    instance._passkeyError.set(null);
    instance._passkeySuccess.set(null);

    Meteor.call("passkey.remove", credentialId, function (err) {
      if (err) {
        instance._passkeyError.set(err.reason || "Failed to remove.");
      } else {
        instance._passkeySuccess.set("Passkey removed.");
      }
    });
  },
});

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

const MAX_PASSKEY_NAME_LENGTH = 100;

function passkeyCeremonyErrorMessage(err, fallbackMessage) {
  if (err instanceof WebAuthnError) {
    return err.message || (err.cause && err.cause.message) || fallbackMessage;
  }

  return (err && err.message) || fallbackMessage;
}

function passkeyNameTooLongMessage() {
  return "Passkey name must be " + MAX_PASSKEY_NAME_LENGTH + " characters or fewer.";
}

// Identifier-first login: authenticate with existing passkey
function authenticateWithPasskey(options, callback) {
  startAuthentication({ optionsJSON: options }).then(function (authResponse) {
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
      if (err.code === "ERROR_CEREMONY_ABORTED") {
        return;
      }
    }
    callback(new Meteor.Error(403, passkeyCeremonyErrorMessage(
      err, "Something went wrong. Please try again."
    )));
  });
}

// Identifier-first registration: create passkey and account
function registerWithPasskey(options, callback) {
  startRegistration({ optionsJSON: options }).then(function (attestationResponse) {
    Accounts.callLoginMethod({
      methodArguments: [{ passkeyRegister: attestationResponse }],
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
      if (err.code === "ERROR_CEREMONY_ABORTED") {
        return;
      }
    }
    callback(new Meteor.Error(403, passkeyCeremonyErrorMessage(
      err, "Something went wrong. Please try again."
    )));
  });
}

// Legacy one-click login (used by initiateLogin for returning users in credential list)
const loginWithPasskey = function (callback) {
  if (!window.isSecureContext) {
    callback(new Meteor.Error(403, "Passkeys require HTTPS, or a localhost development URL."));
    return;
  }

  Meteor.call("passkey.generateAuthenticationOptions", function (err, optionsJSON) {
    if (err) {
      callback(err);
      return;
    }

    authenticateWithPasskey(optionsJSON, callback);
  });
};

export { loginWithPasskey, browserSupportsWebAuthn };

// Conditional UI: start in background so autofill shows passkeys
function initConditionalUI() {
  if (!browserSupportsWebAuthn()) return;
  if (!window.isSecureContext) return;
  if (!window.PublicKeyCredential || !window.PublicKeyCredential.isConditionalMediationAvailable) return;

  PublicKeyCredential.isConditionalMediationAvailable().then(function (available) {
    if (!available) return;

    Meteor.call("passkey.generateAuthenticationOptions", function (err, optionsJSON) {
      if (err) return;

      startAuthentication({ optionsJSON, useBrowserAutofill: true }).then(function (authResponse) {
        Accounts.callLoginMethod({
          methodArguments: [{ passkey: authResponse }],
          userCallback: function (error) {
            if (error) {
              console.error("Passkey autofill login failed:", error);
            } else {
              // Close login overlays
              const grainviews = typeof globalGrains !== "undefined" ? globalGrains.getAll() : [];
              grainviews.forEach(function (grainview) {
                grainview.disableSigninOverlay();
              });
            }
          },
        });
      }).catch(function () {
        // Conditional UI was cancelled or failed silently; no action needed.
      });
    });
  });
}

// Login form template
Template.passkeyLoginForm.onCreated(function () {
  this._passkeyError = new ReactiveVar(null);
});

Template.passkeyLoginForm.onRendered(function () {
  initConditionalUI();
});

Template.passkeyLoginForm.helpers({
  webAuthnSupported() {
    return browserSupportsWebAuthn();
  },

  passkeyError() {
    return Template.instance()._passkeyError.get();
  },
});

Template.passkeyLoginForm.events({
  "submit form.passkey-login-form"(event, instance) {
    event.preventDefault();

    const email = event.currentTarget.email.value.trim();
    if (!email) {
      instance._passkeyError.set("Please enter an email address.");
      return;
    }

    if (!window.isSecureContext) {
      instance._passkeyError.set("Passkeys require HTTPS, or a localhost development URL.");
      return;
    }

    instance._passkeyError.set(null);

    if (instance.data.linkingNewCredential) {
      sessionStorage.setItem("linkingCredentialLoginToken", Accounts._storedLoginToken());
    }

    Meteor.call("passkey.initiateWithEmail", email, function (err, result) {
      if (err) {
        instance._passkeyError.set(err.reason || "Something went wrong.");
        return;
      }

      const callback = function (err) {
        if (err) {
          instance._passkeyError.set(err.reason || "Something went wrong.");
        } else {
          // Close login overlays
          const grainviews = typeof globalGrains !== "undefined" ? globalGrains.getAll() : [];
          grainviews.forEach(function (grainview) {
            grainview.disableSigninOverlay();
          });
        }
      };

      if (result.mode === "authenticate") {
        authenticateWithPasskey(result.options, callback);
      } else {
        registerWithPasskey(result.options, callback);
      }
    });
  },
});

// Account settings: passkey management (unchanged from existing code)
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

    const allCredentials = (user.loginCredentials || []).concat(user.nonloginCredentials || []);
    allCredentials.forEach(function (cred) {
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

  passkeyNameMaxLength() {
    return MAX_PASSKEY_NAME_LENGTH;
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

    if (!window.isSecureContext) {
      instance._passkeyError.set("Passkeys require HTTPS, or a localhost development URL.");
      return;
    }

    Meteor.call("passkey.generateRegistrationOptions", function (err, result) {
      if (err) {
        instance._passkeyError.set(err.reason || "Failed to start registration.");
        return;
      }

      const { options: optionsJSON } = result;
      const friendlyName = prompt("Name this passkey (optional):");
      if (friendlyName === null) return;
      if (friendlyName.trim().length > MAX_PASSKEY_NAME_LENGTH) {
        instance._passkeyError.set(passkeyNameTooLongMessage());
        return;
      }

      startRegistration({ optionsJSON }).then(function (attestationResponse) {
        Meteor.call("passkey.verifyRegistration",
          attestationResponse, friendlyName || null,
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
          if (err.code === "ERROR_CEREMONY_ABORTED") {
            return;
          }
        }
        instance._passkeyError.set(passkeyCeremonyErrorMessage(
          err, "Something went wrong. Please try again."
        ));
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
    instance._passkeyError.set(null);
    if (newName.trim().length > MAX_PASSKEY_NAME_LENGTH) {
      instance._passkeyError.set(passkeyNameTooLongMessage());
      return;
    }

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

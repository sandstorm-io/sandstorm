# Passkey Account Creation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable new account creation and login via a single passkey form using email-based server-side routing and WebAuthn conditional UI.

**Architecture:** Add a `passkey.initiateWithEmail(email)` server method that checks if the email maps to an existing passkey credential and returns either authentication or registration options. The client calls the appropriate WebAuthn ceremony based on the mode. Registration creates a credential user and logs the user in via a new `passkeyRegister` branch in the existing login handler. Conditional UI (`autocomplete="username webauthn"`) lets returning users sign in from autofill without clicking any button.

**Tech Stack:** Meteor, Blaze, @simplewebauthn/server, @simplewebauthn/browser, MongoDB

**Codebase note:** This builds on mnutt's `passkey-auth` branch (commit `1c950b5f`). All file references are relative to that branch. The code runs on an older Node version that requires polyfills for `crypto.subtle` and `Promise.any` (already present in `passkey-server.js`).

---

### Task 1: Add email field to passkey credential data model

**Files:**
- Modify: `shell/imports/sandstorm-db/db.js` (add index)
- Modify: `shell/imports/sandstorm-db/profile.js` (publish email field, use email in profile defaults)

- [ ] **Step 1: Add sparse index on `services.passkey.email`**

In `shell/imports/sandstorm-db/db.js`, find the existing passkey index line:

```javascript
Meteor.users.ensureIndexOnServer("services.passkey.keys.credentialId", { unique: 1, sparse: 1 });
```

Add directly below it:

```javascript
Meteor.users.ensureIndexOnServer("services.passkey.email", { sparse: 1 });
```

- [ ] **Step 2: Add `services.passkey.email` to the `credentialDetails` publication**

In `shell/imports/sandstorm-db/profile.js`, find the block:

```javascript
        "services.passkey.userHandle": 1,
        "services.passkey.keys.credentialId": 1,
```

Add `"services.passkey.email": 1,` above `"services.passkey.userHandle"`:

```javascript
        "services.passkey.email": 1,
        "services.passkey.userHandle": 1,
        "services.passkey.keys.credentialId": 1,
```

- [ ] **Step 3: Use email in profile defaults**

In `shell/imports/sandstorm-db/profile.js`, find the passkey branch in `fillInProfileDefaults`:

```javascript
  } else if (services.passkey) {
    profile.name = profile.name || "Passkey User";
    profile.handle = profile.handle || filterHandle("passkey_" + services.passkey.userHandle.slice(0, 8));
  }
```

Replace with:

```javascript
  } else if (services.passkey) {
    profile.name = profile.name || (services.passkey.email ? services.passkey.email.split("@")[0] : "Passkey User");
    profile.handle = profile.handle || (services.passkey.email ? filterHandle(emailToHandle(services.passkey.email)) : filterHandle("passkey_" + services.passkey.userHandle.slice(0, 8)));
  }
```

(`emailToHandle` is already defined in the same file and used by the SAML/LDAP branches.)

- [ ] **Step 4: Commit**

```bash
git add shell/imports/sandstorm-db/db.js shell/imports/sandstorm-db/profile.js
git commit -m "feat(passkey): add email field to credential data model and profile defaults"
```

---

### Task 2: Add `passkey.initiateWithEmail` server method

**Files:**
- Modify: `shell/imports/server/accounts/passkey/passkey-server.js`

- [ ] **Step 1: Update `storeChallenge` to accept email**

Find the `storeChallenge` function:

```javascript
function storeChallenge(connectionId, challenge, userHandle) {
  pendingChallenges.set(connectionId, {
    challenge,
    userHandle: userHandle || null,
    createdAt: Date.now(),
  });
}
```

Replace with:

```javascript
function storeChallenge(connectionId, challenge, userHandle, email) {
  pendingChallenges.set(connectionId, {
    challenge,
    userHandle: userHandle || null,
    email: email || null,
    createdAt: Date.now(),
  });
}
```

- [ ] **Step 2: Update `consumeChallenge` to return email**

Find the `consumeChallenge` function:

```javascript
function consumeChallenge(connectionId) {
  const entry = pendingChallenges.get(connectionId);
  pendingChallenges.delete(connectionId);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > CHALLENGE_EXPIRY_MS) return null;
  return { challenge: entry.challenge, userHandle: entry.userHandle };
}
```

Replace with:

```javascript
function consumeChallenge(connectionId) {
  const entry = pendingChallenges.get(connectionId);
  pendingChallenges.delete(connectionId);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > CHALLENGE_EXPIRY_MS) return null;
  return { challenge: entry.challenge, userHandle: entry.userHandle, email: entry.email };
}
```

- [ ] **Step 3: Add the `passkey.initiateWithEmail` method**

Inside the `Meteor.methods({...})` block, add the following method after `passkey.generateAuthenticationOptions`:

```javascript
  "passkey.initiateWithEmail": async function (email) {
    check(email, String);
    email = email.trim().toLowerCase();

    if (!email || !email.includes("@")) {
      throw new Meteor.Error(400, "Please enter a valid email address.");
    }

    if (!Accounts.loginServices.passkey.isEnabled()) {
      throw new Meteor.Error(403, "Passkey login service is disabled.");
    }

    const rpID = getRpId();
    const rpName = globalDb.getServerTitle() || "Sandstorm";

    // Look for an existing passkey credential with this email
    const passkeyCredUser = Meteor.users.findOne({
      "services.passkey.email": email,
    });

    if (passkeyCredUser && passkeyCredUser.services.passkey.keys && passkeyCredUser.services.passkey.keys.length > 0) {
      // User has a passkey: return authentication options
      const keys = passkeyCredUser.services.passkey.keys;
      const options = await generateAuthenticationOptions({
        rpID,
        challenge: Random.secret(32),
        allowCredentials: keys.map(function (key) {
          return { id: key.credentialId, transports: key.transports };
        }),
        userVerification: "preferred",
        timeout: 300000,
      });

      storeChallenge(this.connection.id, options.challenge, null, email);
      return { mode: "authenticate", options };
    }

    // No passkey found: also check if this email belongs to any account
    // (via Google, email token, GitHub) that has a linked passkey credential
    let foundPasskeyKeys = null;
    const emailCredUsers = Meteor.users.find({
      $or: [
        { "services.email.email": email },
        { "services.google.email": email },
        { "services.github.emails.email": email },
      ],
    }).fetch();

    for (const credUser of emailCredUsers) {
      // Find accounts that link this credential
      const accounts = Meteor.users.find({
        "loginCredentials.id": credUser._id,
      }).fetch();

      for (const account of accounts) {
        // Check if any linked credential is a passkey
        for (const cred of (account.loginCredentials || [])) {
          const linkedCred = Meteor.users.findOne({ _id: cred.id });
          if (linkedCred && linkedCred.services && linkedCred.services.passkey &&
              linkedCred.services.passkey.keys && linkedCred.services.passkey.keys.length > 0) {
            foundPasskeyKeys = linkedCred.services.passkey.keys;
            break;
          }
        }
        if (foundPasskeyKeys) break;
      }
      if (foundPasskeyKeys) break;
    }

    if (foundPasskeyKeys) {
      // Found a passkey via linked account: return authentication options
      const options = await generateAuthenticationOptions({
        rpID,
        challenge: Random.secret(32),
        allowCredentials: foundPasskeyKeys.map(function (key) {
          return { id: key.credentialId, transports: key.transports };
        }),
        userVerification: "preferred",
        timeout: 300000,
      });

      storeChallenge(this.connection.id, options.challenge, null, email);
      return { mode: "authenticate", options };
    }

    // No passkey found anywhere: return registration options
    const userHandle = Random.secret(32);

    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      challenge: Random.secret(32),
      userName: email,
      userDisplayName: email.split("@")[0],
      userID: new TextEncoder().encode(userHandle),
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "preferred",
      },
      supportedAlgorithmIDs: SUPPORTED_PASSKEY_ALGORITHMS,
      attestation: "none",
      timeout: 300000,
    });

    storeChallenge(this.connection.id, options.challenge, userHandle, email);
    return { mode: "register", options };
  },
```

- [ ] **Step 4: Commit**

```bash
git add shell/imports/server/accounts/passkey/passkey-server.js
git commit -m "feat(passkey): add initiateWithEmail server method for identifier-first flow"
```

---

### Task 3: Add `passkeyRegister` branch to login handler

**Files:**
- Modify: `shell/imports/server/accounts/passkey/passkey-server.js`

- [ ] **Step 1: Add registration handling to the login handler**

Find the login handler at the bottom of `passkey-server.js`:

```javascript
Accounts.registerLoginHandler("passkey", async function (options) {
  if (!options.passkey) return undefined;
```

Replace the first two lines with:

```javascript
Accounts.registerLoginHandler("passkey", async function (options) {
  if (!options.passkey && !options.passkeyRegister) return undefined;

  if (!Accounts.loginServices.passkey.isEnabled()) {
    throw new Meteor.Error(403, "Passkey login service is disabled.");
  }

  // Handle registration-and-login (new account creation or linking)
  if (options.passkeyRegister) {
    check(options.passkeyRegister, Object);

    const connectionId = this.connection.id;
    const challengeData = consumeChallenge(connectionId);
    if (!challengeData) {
      throw new Meteor.Error(403, "Challenge expired or not found.");
    }

    const { challenge: expectedChallenge, userHandle, email } = challengeData;
    if (!userHandle) {
      throw new Meteor.Error(403, "Invalid registration state.");
    }

    const rpID = getRpId();
    const expectedOrigin = getExpectedOrigin();

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: options.passkeyRegister,
        expectedChallenge,
        expectedOrigin,
        expectedRPID: rpID,
        requireUserVerification: false,
        supportedAlgorithmIDs: SUPPORTED_PASSKEY_ALGORITHMS,
      });
    } catch (err) {
      throw new Meteor.Error(403, "Passkey registration failed: " + err.message);
    }

    if (!verification.verified || !verification.registrationInfo) {
      throw new Meteor.Error(403, "Passkey registration failed.");
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

    const now = new Date();
    const keyEntry = {
      credentialId: credential.id,
      publicKey: uint8ArrayToBase64url(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports || [],
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      friendlyName: defaultPasskeyName(now),
      createdAt: now,
      lastUsedAt: now,
    };

    const credentialUserId = SHA256("passkey:" + userHandle);
    const user = {
      _id: credentialUserId,
      services: {
        passkey: {
          userHandle: userHandle,
          email: email || null,
          keys: [keyEntry],
        },
      },
    };

    Accounts.insertUserDoc({}, user);

    return { userId: credentialUserId };
  }
```

Then remove the duplicate `if (!Accounts.loginServices.passkey.isEnabled())` check that now follows (since we moved it above). Find the existing block after the `if (!options.passkey) return undefined;` line:

```javascript
  if (!Accounts.loginServices.passkey.isEnabled()) {
    throw new Meteor.Error(403, "Passkey login service is disabled.");
  }

  check(options.passkey, Object);
```

Replace with just:

```javascript
  check(options.passkey, Object);
```

- [ ] **Step 2: Commit**

```bash
git add shell/imports/server/accounts/passkey/passkey-server.js
git commit -m "feat(passkey): add passkeyRegister branch to login handler for account creation"
```

---

### Task 4: Update login page template to identifier-first form

**Files:**
- Modify: `shell/imports/client/accounts/passkey/passkey-templates.html`
- Modify: `shell/i18n/en.i18n.json`

- [ ] **Step 1: Replace the bare button template with email form**

In `shell/imports/client/accounts/passkey/passkey-templates.html`, replace the `passkeyLoginForm` template:

```html
<template name="passkeyLoginForm">
  {{#if webAuthnSupported}}
  <button class="login oneclick passkey">
    {{loginProviderLabel}}
  </button>
  {{/if}}
</template>
```

With:

```html
<template name="passkeyLoginForm">
{{#let txt="accounts.loginButtons.passkeyLoginForm"}}
  {{#if webAuthnSupported}}
  <form class="passkey-login-form">
    <label class="email">
      {{_ (con txt "emailLabel")}}
      <input name="email" type="email" autocomplete="username webauthn"
             placeholder="{{_ (con txt "emailPlaceholder")}}">
    </label>
    <div class="button-box">
      <button class="login email passkey" type="submit">{{_ (con txt "continueButton")}}</button>
    </div>
    {{#if passkeyError}}
      <p class="error-message">{{passkeyError}}</p>
    {{/if}}
  </form>
  {{/if}}
{{/let}}
</template>
```

- [ ] **Step 2: Add i18n keys**

In `shell/i18n/en.i18n.json`, find the existing passkey login button keys:

```json
    "passkeyLoginForm": {
      "label": "with Passkey"
    },
```

Replace with:

```json
    "passkeyLoginForm": {
      "label": "with Passkey",
      "emailLabel": "Email",
      "emailPlaceholder": "you@example.com",
      "continueButton": "Continue with Passkey"
    },
```

- [ ] **Step 3: Commit**

```bash
git add shell/imports/client/accounts/passkey/passkey-templates.html shell/i18n/en.i18n.json
git commit -m "feat(passkey): replace bare login button with email-first form"
```

---

### Task 5: Update client-side login flow for identifier-first routing

**Files:**
- Modify: `shell/imports/client/accounts/passkey/passkey-client.js`

- [ ] **Step 1: Rewrite `loginWithPasskey` and add `registerWithPasskey`**

Replace the entire content of `shell/imports/client/accounts/passkey/passkey-client.js` with:

```javascript
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

import { TAPi18n } from "meteor/tap:i18n";

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
```

- [ ] **Step 2: Commit**

```bash
git add shell/imports/client/accounts/passkey/passkey-client.js
git commit -m "feat(passkey): update client to identifier-first flow with conditional UI"
```

---

### Task 6: Update service registration for form-based login

**Files:**
- Modify: `shell/imports/sandstorm-accounts-packages/accounts.js`

- [ ] **Step 1: Change `initiateLogin` to return `{ form: true }`**

In `shell/imports/sandstorm-accounts-packages/accounts.js`, find the passkey service registration:

```javascript
  initiateLogin(loginId) {
    if (Meteor.isClient) {
      // Dynamically require to avoid server-side import issues
      const { loginWithPasskey } = require("/imports/client/accounts/passkey/passkey-client");
      loginWithPasskey(function (err) {
        if (err) console.error("Passkey login failed:", err);
      });
    }
    return { oneClick: true };
  },
```

Replace with:

```javascript
  initiateLogin(loginId) {
    if (Meteor.isClient) {
      // Dynamically require to avoid server-side import issues
      const { loginWithPasskey } = require("/imports/client/accounts/passkey/passkey-client");
      loginWithPasskey(function (err) {
        if (err) console.error("Passkey login failed:", err);
      });
    }
    return { form: true };
  },
```

This changes the passkey login from a one-click button to a form-based flow, so the login template renders as an inline form instead of a bare button.

- [ ] **Step 2: Commit**

```bash
git add shell/imports/sandstorm-accounts-packages/accounts.js
git commit -m "feat(passkey): change initiateLogin to form-based for identifier-first flow"
```

---

### Task 7: Manual testing on sandstorm.vex.trade

**No files to modify. This is a deployment and testing task.**

- [ ] **Step 1: Build and deploy**

Build the updated code (either locally or via CI), then deploy to the test server following the same process used previously:

```bash
# On the server:
sudo /opt/sandstorm/sandstorm stop
# Copy and extract the new bundle to /opt/sandstorm/sandstorm-custom.YYYY-MM-DD_HH-MM-SS
sudo chown -R root:root /opt/sandstorm/sandstorm-custom.YYYY-MM-DD_HH-MM-SS
sudo ln -sfn sandstorm-custom.YYYY-MM-DD_HH-MM-SS /opt/sandstorm/latest
sudo /opt/sandstorm/sandstorm start
```

- [ ] **Step 2: Test new user registration**

1. Open `https://sandstorm.vex.trade` in a private/incognito window
2. Verify the passkey login form shows an email input and "Continue with Passkey" button
3. Enter a new email address that has no Sandstorm account
4. Click "Continue with Passkey"
5. Verify the browser shows a "Create a passkey" prompt (Touch ID / platform authenticator)
6. Complete the ceremony
7. Verify you are logged in and see the Sandstorm onboarding flow (set name, handle)

- [ ] **Step 3: Test returning user authentication**

1. Sign out
2. Enter the same email address
3. Click "Continue with Passkey"
4. Verify the browser shows a "Use your passkey" prompt (not "insert security key")
5. Complete the ceremony
6. Verify you are logged in to the same account

- [ ] **Step 4: Test conditional UI (autofill)**

1. Sign out
2. Click on the email input field
3. If the browser supports conditional UI, verify the passkey appears in the autofill dropdown
4. Select it and verify authentication succeeds without clicking the button

- [ ] **Step 5: Test error cases**

1. Enter an invalid email and click the button: verify error message appears
2. Cancel the WebAuthn ceremony: verify the form returns to its initial state (no error)
3. Try the flow over HTTP (if accessible): verify "Passkeys require HTTPS" error

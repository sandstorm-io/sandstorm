# Passkey Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add WebAuthn/passkey support as a standalone login method to Sandstorm, matching existing auth patterns.

**Architecture:** New passkey auth provider follows the email-token/LDAP pattern: server-side `Accounts.registerLoginHandler`, client-side Blaze templates, admin enable/disable toggle. Uses `@simplewebauthn/server` and `@simplewebauthn/browser` for WebAuthn ceremony handling. Credential/account separation model: one credential user per person with an array of registered passkeys.

**Tech Stack:** Meteor 2.3.5, Blaze templates, MongoDB, `@simplewebauthn/server` v11+, `@simplewebauthn/browser` v11+

**Spec:** `docs/superpowers/specs/2026-05-06-passkey-auth-design.md`

---

## File Structure

**New files:**
- `shell/imports/server/accounts/passkey/passkey-server.js`: Server-side login handler, Meteor methods for registration/authentication, in-memory challenge storage
- `shell/imports/client/accounts/passkey/passkey-client.js`: `loginWithPasskey()`, `registerPasskey()`, feature detection, error handling
- `shell/imports/client/accounts/passkey/passkey-templates.html`: Blaze templates for login button and account settings passkey management
- `shell/public/passkey.svg`: FIDO Alliance passkey icon

**Modified files:**
- `shell/package.json`: Add npm dependencies
- `shell/imports/sandstorm-db/db.js:162`: Add sparse index
- `shell/imports/sandstorm-db/profile.js:65-107,199-257,259-289,283-289`: Add passkey branches to publications, `fillInProfileDefaults`, `getIntrinsicName`, `getServiceName`
- `shell/imports/sandstorm-accounts-packages/accounts.js`: Register `Accounts.loginServices.passkey`
- `shell/imports/client/admin/login-providers.js:11-85`: Add passkey to `idpData` array
- `shell/imports/client/admin/login-providers.html:468`: Add `adminLoginProviderConfigurePasskey` template
- `shell/imports/client/accounts/account-settings.html:83-84`: Add passkey management section
- `shell/imports/client/accounts/account-settings.js`: Add passkey management logic
- `shell/server/main.ts:69-70`: Add server import
- `shell/client/main.ts:67-70,110-116`: Add client imports
- `shell/i18n/en.i18n.json`: Add translation keys

---

### Task 1: Install npm Dependencies

**Files:**
- Modify: `shell/package.json`

- [ ] **Step 1: Add @simplewebauthn/server and @simplewebauthn/browser to package.json**

In `shell/package.json`, add two entries to the `"dependencies"` object:

```json
"@simplewebauthn/browser": "^11.0.0",
"@simplewebauthn/server": "^11.0.0",
```

Add them alphabetically. They go right after the `"@root/pem"` entry:

```json
"@root/pem": "^1.0.4",
"@simplewebauthn/browser": "^11.0.0",
"@simplewebauthn/server": "^11.0.0",
"@types/fibers": "^3.1.1",
```

- [ ] **Step 2: Install dependencies**

Run: `cd shell && meteor npm install`
Expected: Dependencies install successfully, `package-lock.json` updated.

- [ ] **Step 3: Commit**

```bash
git add shell/package.json shell/package-lock.json
git commit -m "feat(passkey): add @simplewebauthn/server and @simplewebauthn/browser dependencies"
```

---

### Task 2: Database Index and Profile Integration

**Files:**
- Modify: `shell/imports/sandstorm-db/db.js`
- Modify: `shell/imports/sandstorm-db/profile.js`

- [ ] **Step 1: Add sparse index for passkey credentialId lookup**

In `shell/imports/sandstorm-db/db.js`, after line 162 (`suspended.willDelete` index), add:

```javascript
Meteor.users.ensureIndexOnServer("services.passkey.keys.credentialId", { sparse: 1 });
```

- [ ] **Step 2: Add passkey fields to credentialDetails publication**

In `shell/imports/sandstorm-db/profile.js`, inside the `credentialDetails` publication's `fields` object (after the `services.saml.displayName` entry at line 104), add:

```javascript
        "services.passkey.userHandle": 1,
        "services.passkey.keys.credentialId": 1,
        "services.passkey.keys.friendlyName": 1,
        "services.passkey.keys.createdAt": 1,
        "services.passkey.keys.lastUsedAt": 1,
        "services.passkey.keys.transports": 1,
        "services.passkey.keys.deviceType": 1,
        "services.passkey.keys.backedUp": 1,
```

Note: `publicKey` and `counter` are intentionally excluded from the client publication.

- [ ] **Step 3: Add passkey branch to fillInProfileDefaults**

In `shell/imports/sandstorm-db/profile.js`, in the `fillInProfileDefaults` function, after the `} else if (services.saml) {` block (line 245-247) and before the `} else {` block (line 248-250), add:

```javascript
  } else if (services.passkey) {
    profile.name = profile.name || "Passkey User";
    profile.handle = profile.handle || filterHandle("passkey_" + services.passkey.userHandle.slice(0, 8));
```

- [ ] **Step 4: Add passkey branch to getIntrinsicName**

In `shell/imports/sandstorm-db/profile.js`, in the `getIntrinsicName` function, after the `} else if (services.saml) {` block (line 277-278) and before the `} else {` block (line 279-281), add:

```javascript
  } else if (services.passkey) {
    return services.passkey.userHandle;
```

- [ ] **Step 5: Commit**

```bash
git add shell/imports/sandstorm-db/db.js shell/imports/sandstorm-db/profile.js
git commit -m "feat(passkey): add database index and profile integration for passkey credentials"
```

---

### Task 3: Server-Side Passkey Handler

**Files:**
- Create: `shell/imports/server/accounts/passkey/passkey-server.js`
- Modify: `shell/server/main.ts`

- [ ] **Step 1: Create the passkey server module**

Create `shell/imports/server/accounts/passkey/passkey-server.js`:

```javascript
import { Meteor } from "meteor/meteor";
import { Match, check } from "meteor/check";
import { Random } from "meteor/random";
import { Accounts } from "meteor/accounts-base";
import { SHA256 } from "meteor/sha";

import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";

import { SandstormDb } from "/imports/sandstorm-db/db";
import { globalDb } from "/imports/db-deprecated";

// Challenge storage: in-memory Map keyed by connection.id
// Challenges expire after 5 minutes and are single-use.
const CHALLENGE_EXPIRY_MS = 5 * 60 * 1000;
const pendingChallenges = new Map();

function storeChallenge(connectionId, challenge) {
  pendingChallenges.set(connectionId, {
    challenge,
    createdAt: Date.now(),
  });
}

function consumeChallenge(connectionId) {
  const entry = pendingChallenges.get(connectionId);
  pendingChallenges.delete(connectionId);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > CHALLENGE_EXPIRY_MS) return null;
  return entry.challenge;
}

// Periodic cleanup of expired challenges
SandstormDb.periodicCleanup(CHALLENGE_EXPIRY_MS, function () {
  const now = Date.now();
  for (const [key, entry] of pendingChallenges) {
    if (now - entry.createdAt > CHALLENGE_EXPIRY_MS) {
      pendingChallenges.delete(key);
    }
  }
});

function getRpId() {
  return new URL(Meteor.absoluteUrl()).hostname;
}

function getExpectedOrigin() {
  const url = Meteor.absoluteUrl();
  // Strip trailing slash
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

// Base64url encode/decode helpers for public key storage
function uint8ArrayToBase64url(uint8Array) {
  return Buffer.from(uint8Array).toString("base64url");
}

function base64urlToUint8Array(base64url) {
  return new Uint8Array(Buffer.from(base64url, "base64url"));
}

Meteor.methods({
  "passkey.generateRegistrationOptions": async function () {
    if (!this.userId) {
      throw new Meteor.Error(403, "Must be logged in to register a passkey.");
    }

    if (!Accounts.loginServices.passkey.isEnabled()) {
      throw new Meteor.Error(403, "Passkey login service is disabled.");
    }

    // Find existing passkey credential for this account, if any
    const account = Meteor.users.findOne({ _id: this.userId });
    if (!account || !account.loginCredentials) {
      throw new Meteor.Error(403, "Must be logged in to an account.");
    }

    let userHandle;
    let existingKeys = [];
    // Look through linked credentials for an existing passkey credential
    for (const cred of account.loginCredentials) {
      const credUser = Meteor.users.findOne({ _id: cred.id });
      if (credUser && credUser.services && credUser.services.passkey) {
        userHandle = credUser.services.passkey.userHandle;
        existingKeys = credUser.services.passkey.keys || [];
        break;
      }
    }

    // Generate a new userHandle if no existing passkey credential
    if (!userHandle) {
      userHandle = uint8ArrayToBase64url(Random.secret(32));
    }

    const rpID = getRpId();
    const rpName = globalDb.getServerTitle() || "Sandstorm";

    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userName: rpID,
      userDisplayName: "Sandstorm User",
      userID: base64urlToUint8Array(userHandle),
      excludeCredentials: existingKeys.map(function (key) {
        return {
          id: key.credentialId,
          transports: key.transports,
        };
      }),
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "preferred",
      },
      attestation: "none",
      timeout: 300000,
    });

    storeChallenge(this.connection.id, options.challenge);

    return { options, userHandle };
  },

  "passkey.verifyRegistration": async function (attestationResponse, friendlyName) {
    check(attestationResponse, Object);
    check(friendlyName, Match.Optional(String));

    if (!this.userId) {
      throw new Meteor.Error(403, "Must be logged in to register a passkey.");
    }

    if (!Accounts.loginServices.passkey.isEnabled()) {
      throw new Meteor.Error(403, "Passkey login service is disabled.");
    }

    const expectedChallenge = consumeChallenge(this.connection.id);
    if (!expectedChallenge) {
      throw new Meteor.Error(403, "Challenge expired or not found. Please try again.");
    }

    const rpID = getRpId();
    const expectedOrigin = getExpectedOrigin();

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: attestationResponse,
        expectedChallenge,
        expectedOrigin,
        expectedRPID: rpID,
      });
    } catch (err) {
      throw new Meteor.Error(403, "Passkey registration failed: " + err.message);
    }

    if (!verification.verified || !verification.registrationInfo) {
      throw new Meteor.Error(403, "Passkey registration failed.");
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

    const now = new Date();
    const name = friendlyName ||
      ("Passkey (" + now.toISOString().slice(0, 10) + ")");

    const keyEntry = {
      credentialId: credential.id,
      publicKey: uint8ArrayToBase64url(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports || [],
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      friendlyName: name,
      createdAt: now,
      lastUsedAt: now,
    };

    // Find or retrieve the userHandle from the registration options we stored
    const account = Meteor.users.findOne({ _id: this.userId });
    let passkeyCredentialId = null;

    for (const cred of (account.loginCredentials || [])) {
      const credUser = Meteor.users.findOne({ _id: cred.id });
      if (credUser && credUser.services && credUser.services.passkey) {
        passkeyCredentialId = credUser._id;
        break;
      }
    }

    if (passkeyCredentialId) {
      // Existing passkey credential: add new key
      Meteor.users.update(
        { _id: passkeyCredentialId },
        { $push: { "services.passkey.keys": keyEntry } }
      );
    } else {
      // New passkey credential: need to get the userHandle
      // We pass it back from generateRegistrationOptions, but the client needs to send it
      // Actually, we need to look it up. The client received it from generateRegistrationOptions.
      // For now, derive it from the attestation response's userHandle field.
      // The userHandle was passed to the client in generateRegistrationOptions.
      // We need the client to send it back. Let's accept it as a parameter.
      throw new Meteor.Error(500,
        "Internal error: no existing passkey credential found. " +
        "Use passkey.verifyRegistrationNewUser instead.");
    }

    return { credentialId: credential.id, friendlyName: name };
  },

  "passkey.verifyRegistrationNewUser": async function (attestationResponse, userHandle, friendlyName) {
    check(attestationResponse, Object);
    check(userHandle, String);
    check(friendlyName, Match.Optional(String));

    if (!this.userId) {
      throw new Meteor.Error(403, "Must be logged in to register a passkey.");
    }

    if (!Accounts.loginServices.passkey.isEnabled()) {
      throw new Meteor.Error(403, "Passkey login service is disabled.");
    }

    const expectedChallenge = consumeChallenge(this.connection.id);
    if (!expectedChallenge) {
      throw new Meteor.Error(403, "Challenge expired or not found. Please try again.");
    }

    const rpID = getRpId();
    const expectedOrigin = getExpectedOrigin();

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: attestationResponse,
        expectedChallenge,
        expectedOrigin,
        expectedRPID: rpID,
      });
    } catch (err) {
      throw new Meteor.Error(403, "Passkey registration failed: " + err.message);
    }

    if (!verification.verified || !verification.registrationInfo) {
      throw new Meteor.Error(403, "Passkey registration failed.");
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

    const now = new Date();
    const name = friendlyName ||
      ("Passkey (" + now.toISOString().slice(0, 10) + ")");

    const keyEntry = {
      credentialId: credential.id,
      publicKey: uint8ArrayToBase64url(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports || [],
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
      friendlyName: name,
      createdAt: now,
      lastUsedAt: now,
    };

    // Create new credential user
    const credentialUserId = SHA256("passkey:" + userHandle);
    const user = {
      _id: credentialUserId,
      services: {
        passkey: {
          userHandle: userHandle,
          keys: [keyEntry],
        },
      },
    };

    Accounts.insertUserDoc({}, user);

    // Link the credential to the current account
    Accounts.linkCredentialToAccount(
      this.connection.sandstormDb,
      this.connection.sandstormBackend,
      credentialUserId,
      this.userId,
      true // allowLogin
    );

    return { credentialId: credential.id, friendlyName: name };
  },

  "passkey.generateAuthenticationOptions": async function () {
    if (!Accounts.loginServices.passkey.isEnabled()) {
      throw new Meteor.Error(403, "Passkey login service is disabled.");
    }

    const rpID = getRpId();

    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: [],
      userVerification: "preferred",
      timeout: 300000,
    });

    storeChallenge(this.connection.id, options.challenge);

    return options;
  },

  "passkey.rename": function (credentialId, newName) {
    check(credentialId, String);
    check(newName, String);

    if (!this.userId) {
      throw new Meteor.Error(403, "Must be logged in.");
    }

    if (!newName.trim()) {
      throw new Meteor.Error(400, "Name cannot be empty.");
    }

    // Find the credential user that has this key and is linked to the current account
    const account = Meteor.users.findOne({ _id: this.userId });
    if (!account || !account.loginCredentials) {
      throw new Meteor.Error(403, "Must be logged in to an account.");
    }

    for (const cred of account.loginCredentials) {
      const result = Meteor.users.update(
        {
          _id: cred.id,
          "services.passkey.keys.credentialId": credentialId,
        },
        {
          $set: { "services.passkey.keys.$.friendlyName": newName.trim() },
        }
      );
      if (result > 0) return;
    }

    throw new Meteor.Error(404, "Passkey not found.");
  },

  "passkey.remove": function (credentialId) {
    check(credentialId, String);

    if (!this.userId) {
      throw new Meteor.Error(403, "Must be logged in.");
    }

    const account = Meteor.users.findOne({ _id: this.userId });
    if (!account || !account.loginCredentials) {
      throw new Meteor.Error(403, "Must be logged in to an account.");
    }

    for (const cred of account.loginCredentials) {
      const credUser = Meteor.users.findOne({ _id: cred.id });
      if (!credUser || !credUser.services || !credUser.services.passkey) continue;

      const keys = credUser.services.passkey.keys || [];
      const keyIndex = keys.findIndex(function (k) { return k.credentialId === credentialId; });
      if (keyIndex === -1) continue;

      if (keys.length === 1) {
        // Last key: remove entire credential and unlink from account
        Meteor.users.update(
          { _id: this.userId },
          { $pull: { loginCredentials: { id: cred.id } } }
        );
        Meteor.users.remove({ _id: cred.id });
      } else {
        // Remove just this key
        Meteor.users.update(
          { _id: cred.id },
          { $pull: { "services.passkey.keys": { credentialId: credentialId } } }
        );
      }

      return;
    }

    throw new Meteor.Error(404, "Passkey not found.");
  },
});

// Login handler
Accounts.registerLoginHandler("passkey", async function (options) {
  if (!options.passkey) return undefined;

  if (!Accounts.loginServices.passkey.isEnabled()) {
    throw new Meteor.Error(403, "Passkey login service is disabled.");
  }

  check(options.passkey, Object);

  const connectionId = this.connection.id;
  const expectedChallenge = consumeChallenge(connectionId);
  if (!expectedChallenge) {
    throw new Meteor.Error(403, "Challenge expired or not found.");
  }

  // Find credential user by credentialId
  const authResponseId = options.passkey.id;
  const credentialUser = Meteor.users.findOne({
    "services.passkey.keys.credentialId": authResponseId,
  });

  if (!credentialUser) {
    return { error: new Meteor.Error(403, "Passkey not recognized.") };
  }

  const keys = credentialUser.services.passkey.keys;
  const matchingKey = keys.find(function (k) { return k.credentialId === authResponseId; });

  if (!matchingKey) {
    return { error: new Meteor.Error(403, "Passkey not recognized.") };
  }

  const rpID = getRpId();
  const expectedOrigin = getExpectedOrigin();

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: options.passkey,
      expectedChallenge,
      expectedOrigin,
      expectedRPID: rpID,
      credential: {
        id: matchingKey.credentialId,
        publicKey: base64urlToUint8Array(matchingKey.publicKey),
        counter: matchingKey.counter,
        transports: matchingKey.transports,
      },
    });
  } catch (err) {
    console.error("Passkey authentication failed:", err.message);
    return { error: new Meteor.Error(403, "Passkey authentication failed.") };
  }

  if (!verification.verified) {
    return { error: new Meteor.Error(403, "Passkey authentication failed.") };
  }

  const { newCounter, credentialBackedUp } = verification.authenticationInfo;

  // Counter regression check
  if (matchingKey.counter > 0 && newCounter <= matchingKey.counter) {
    console.warn(
      "Passkey counter regression detected for credential",
      authResponseId,
      ": stored =", matchingKey.counter,
      ", received =", newCounter
    );
  }

  // Update credential state
  Meteor.users.update(
    {
      _id: credentialUser._id,
      "services.passkey.keys.credentialId": authResponseId,
    },
    {
      $set: {
        "services.passkey.keys.$.counter": newCounter,
        "services.passkey.keys.$.backedUp": credentialBackedUp,
        "services.passkey.keys.$.lastUsedAt": new Date(),
      },
    }
  );

  return { userId: credentialUser._id };
});
```

- [ ] **Step 2: Add server import in main.ts**

In `shell/server/main.ts`, after line 70 (`import "../imports/server/accounts/saml/saml-server";`), add:

```typescript
import "../imports/server/accounts/passkey/passkey-server";
```

- [ ] **Step 3: Commit**

```bash
git add shell/imports/server/accounts/passkey/passkey-server.js shell/server/main.ts
git commit -m "feat(passkey): add server-side login handler, registration, and authentication methods"
```

---

### Task 4: Service Registration

**Files:**
- Modify: `shell/imports/sandstorm-accounts-packages/accounts.js`

- [ ] **Step 1: Register the passkey login service**

In `shell/imports/sandstorm-accounts-packages/accounts.js`, at the end of the file (after line 66), add:

```javascript
Accounts.loginServices.passkey = {
  isEnabled() {
    const db = SandstormDb.prototype;
    // Use globalDb if available, otherwise check setting directly
    if (typeof globalDb !== "undefined") {
      return globalDb.getSettingWithFallback("passkey", false);
    }
    return false;
  },

  getLoginId(credential) {
    return credential.services.passkey.userHandle;
  },

  initiateLogin(loginId) {
    // This is only called on the client. The actual implementation
    // is in passkey-client.js, called by the template event handler.
  },

  loginTemplate: {
    name: "passkeyLoginForm",
    priority: 1,
    data: { name: "passkey", displayName: "Passkey" },
  },
};
```

Also add the `globalDb` import at the top of the file. After the existing import on line 4:

```javascript
import { globalDb } from "/imports/db-deprecated";
```

- [ ] **Step 2: Commit**

```bash
git add shell/imports/sandstorm-accounts-packages/accounts.js
git commit -m "feat(passkey): register Accounts.loginServices.passkey with login template and isEnabled"
```

---

### Task 5: Client-Side Passkey Templates and Logic

**Files:**
- Create: `shell/imports/client/accounts/passkey/passkey-templates.html`
- Create: `shell/imports/client/accounts/passkey/passkey-client.js`
- Modify: `shell/imports/client/accounts/login-buttons.js`
- Modify: `shell/client/main.ts`

- [ ] **Step 1: Create the passkey Blaze templates**

Create `shell/imports/client/accounts/passkey/passkey-templates.html`:

```html
<template name="passkeyLoginForm">
  {{#if webAuthnSupported}}
  <button class="login oneclick passkey">
    {{loginProviderLabel}}
  </button>
  {{/if}}
</template>

<template name="passkeyManagement">
{{#let txt="accounts.accountSettings.passkey"}}
  {{#if passkeyEnabled}}
  <div class="passkey-management">
    <h3 class="title-bar">{{_ (con txt "title")}}</h3>

    {{#if passkeyError}}
      {{#focusingErrorBox}}
        {{passkeyError}}
      {{/focusingErrorBox}}
    {{/if}}

    {{#if passkeySuccess}}
      {{#focusingSuccessBox}}
        {{passkeySuccess}}
      {{/focusingSuccessBox}}
    {{/if}}

    {{#if passkeys.length}}
    <ul class="passkey-list">
      {{#each passkeys}}
      <li class="passkey-item" data-credential-id="{{credentialId}}">
        {{#if isRenaming}}
          <input class="passkey-rename-input" type="text" value="{{friendlyName}}">
          <button class="passkey-rename-save">{{_ (con txt "saveButton")}}</button>
          <button class="passkey-rename-cancel">{{_ (con txt "cancelButton")}}</button>
        {{else}}
          <span class="passkey-name">{{friendlyName}}</span>
          <span class="passkey-meta">
            {{_ (con txt "added")}} {{formatDate createdAt}}
            {{#if lastUsedAt}}
              · {{_ (con txt "lastUsed")}} {{formatDate lastUsedAt}}
            {{/if}}
          </span>
          <button class="passkey-rename">{{_ (con txt "renameButton")}}</button>
          <button class="passkey-remove">{{_ (con txt "removeButton")}}</button>
        {{/if}}
      </li>
      {{/each}}
    </ul>
    {{else}}
    <p>{{_ (con txt "noPasskeys")}}</p>
    {{/if}}

    <button class="passkey-add">{{_ (con txt "addButton")}}</button>
  </div>
  {{/if}}
{{/let}}
</template>
```

- [ ] **Step 2: Create the passkey client module**

Create `shell/imports/client/accounts/passkey/passkey-client.js`:

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

        const methodName = hasExistingPasskey
          ? "passkey.verifyRegistration"
          : "passkey.verifyRegistrationNewUser";

        const args = hasExistingPasskey
          ? [attestationResponse, friendlyName || null]
          : [attestationResponse, userHandle, friendlyName || null];

        Meteor.call(methodName, ...args, function (err, result) {
          if (err) {
            instance._passkeyError.set(err.reason || "Registration failed.");
          } else {
            instance._passkeySuccess.set(
              "Passkey \"" + result.friendlyName + "\" registered successfully."
            );
          }
        });
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
```

- [ ] **Step 3: Add client imports in main.ts**

In `shell/client/main.ts`, after line 69 (`import "../imports/client/accounts/account-settings.html";`), add:

```typescript
import "../imports/client/accounts/passkey/passkey-templates.html";
```

After line 113 (`import "../imports/client/accounts/saml/saml-client-pt2";`), add:

```typescript
import "../imports/client/accounts/passkey/passkey-client";
```

- [ ] **Step 4: Commit**

```bash
git add shell/imports/client/accounts/passkey/passkey-templates.html shell/imports/client/accounts/passkey/passkey-client.js shell/client/main.ts
git commit -m "feat(passkey): add client-side login button, authentication flow, and account settings management"
```

---

### Task 6: Admin Configuration UI

**Files:**
- Modify: `shell/imports/client/admin/login-providers.js`
- Modify: `shell/imports/client/admin/login-providers.html`

- [ ] **Step 1: Add passkey to the idpData array**

In `shell/imports/client/admin/login-providers.js`, inside the `idpData` function, add a `passkeyEnabled` variable after the `samlEnabled` line (line 20):

```javascript
  const passkeyEnabled = globalDb.getSettingWithFallback("passkey", false);
```

Then add a new entry to the return array, after the SAML entry (after line 83, before the closing `];`):

```javascript
    {
      id: "passkey",
      label: "Passkey",
      icon: "/passkey.svg",
      enabled: passkeyEnabled,
      popupTemplate: "adminLoginProviderConfigurePasskey",
      onConfigure() {
        configureCallback("passkey");
      },
    },
```

- [ ] **Step 2: Add the admin config modal template**

In `shell/imports/client/admin/login-providers.html`, before the `adminLoginProviderTable` template (before line 470), add:

```html
<template name="adminLoginProviderConfigurePasskey">
{{#modalDialogWithBackdrop onDismiss=onDismiss}}
  {{#let txt="admin.identityProviders.adminIdentityProviderConfigurePasskey"}}
  <h2>{{_ (con txt "title")}}</h2>

  {{#if errorMessage}}
    {{#focusingErrorBox}}
      {{_ (con txt "error") errorMessage}}
    {{/focusingErrorBox}}
  {{/if}}

  <form class="setup-idp-form">
    <p>{{_ (con txt "explanation")}}</p>
  </form>

  <div class="idp-modal-button-row">
    <button class="idp-modal-save">
      {{#if passkeyEnabled}}
      {{_ (con txt "saveButton")}}
      {{else}}
      {{_ (con txt "enableButton")}}
      {{/if}}
    </button>
    <button class="idp-modal-cancel">
      {{_ (con txt "cancelButton")}}
    </button>
    {{#if passkeyEnabled}}
    <button class="idp-modal-disable">
      {{_ (con txt "disableButton")}}
    </button>
    {{/if}}
  </div>
  {{/let}}
{{/modalDialogWithBackdrop}}
</template>
```

- [ ] **Step 3: Add the admin config modal JS handlers**

In `shell/imports/client/admin/login-providers.js`, at the end of the file (after line 925), add:

```javascript
// Passkey form.
Template.adminLoginProviderConfigurePasskey.onCreated(function () {
  this.errorMessage = new ReactiveVar(undefined);
  this.setAccountSettingCallback = setAccountSettingCallback.bind(this);
});

Template.adminLoginProviderConfigurePasskey.onRendered(function () {
  this.find("button.idp-modal-save").focus();
});

Template.adminLoginProviderConfigurePasskey.events({
  "click .idp-modal-disable"(evt) {
    const instance = Template.instance();
    const token = Iron.controller().state.get("token");
    Meteor.call("setAccountSetting", token, "passkey", false, instance.setAccountSettingCallback);
  },

  "click .idp-modal-save"(evt) {
    const instance = Template.instance();
    const token = Iron.controller().state.get("token");
    Meteor.call("setAccountSetting", token, "passkey", true, instance.setAccountSettingCallback);
  },

  "click .idp-modal-cancel"(evt) {
    const instance = Template.instance();
    instance.data.onDismiss()();
  },
});

Template.adminLoginProviderConfigurePasskey.helpers({
  passkeyEnabled() {
    return globalDb.getSettingWithFallback("passkey", false);
  },

  errorMessage() {
    const instance = Template.instance();
    return instance.errorMessage.get();
  },
});
```

- [ ] **Step 4: Commit**

```bash
git add shell/imports/client/admin/login-providers.js shell/imports/client/admin/login-providers.html
git commit -m "feat(passkey): add admin panel enable/disable toggle for passkey login provider"
```

---

### Task 7: Account Settings Integration

**Files:**
- Modify: `shell/imports/client/accounts/account-settings.html`

- [ ] **Step 1: Add passkey management section to account settings**

In `shell/imports/client/accounts/account-settings.html`, after the closing `</div>` of the `verified-emails-editor` section (after line 113), add:

```html

  {{> passkeyManagement}}
```

This renders the `passkeyManagement` template defined in `passkey-templates.html`. The template itself handles checking whether passkeys are enabled.

- [ ] **Step 2: Commit**

```bash
git add shell/imports/client/accounts/account-settings.html
git commit -m "feat(passkey): add passkey management section to account settings page"
```

---

### Task 8: Passkey SVG Icon

**Files:**
- Create: `shell/public/passkey.svg`

- [ ] **Step 1: Add the FIDO Alliance passkey icon**

Create `shell/public/passkey.svg` with the FIDO Alliance standard passkey icon. This is a simplified key icon:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M15 7a4 4 0 1 0-4.12 5.53L7.5 16l-1 1L5 18.5l1.5 1.5L8 18.5l1-1 1-1 3.47-3.47A4 4 0 0 0 15 7z"/>
  <circle cx="15" cy="7" r="1"/>
</svg>
```

- [ ] **Step 2: Commit**

```bash
git add shell/public/passkey.svg
git commit -m "feat(passkey): add passkey SVG icon for admin and login UI"
```

---

### Task 9: i18n Translation Keys

**Files:**
- Modify: `shell/i18n/en.i18n.json`

- [ ] **Step 1: Add passkey provider label**

In `shell/i18n/en.i18n.json`, find the `"providers"` object inside `admin.identityProviders` (around line 577). Add:

```json
"passkey": "Passkey"
```

So it becomes:

```json
"providers": {
  "emailPassLess": "E-mail (passwordless)",
  "passkey": "Passkey"
},
```

- [ ] **Step 2: Add admin passkey config translations**

In `shell/i18n/en.i18n.json`, inside the `admin.identityProviders` object, add a new section for the passkey admin modal (after the `adminIdentityProviderConfigureSaml` section):

```json
"adminIdentityProviderConfigurePasskey": {
  "title": "Passkey",
  "explanation": "Passkeys let users sign in with biometrics, security keys, or their phone. No passwords needed. The server derives its identity from its URL automatically.",
  "enableButton": "Enable",
  "saveButton": "Save",
  "disableButton": "Disable",
  "cancelButton": "Cancel",
  "error": "Error: %s"
},
```

- [ ] **Step 3: Add passkey login button translations**

In `shell/i18n/en.i18n.json`, inside the `accounts.loginButtons` section, add:

```json
"passkeyLoginForm": {
  "label": "with Passkey"
},
```

- [ ] **Step 4: Add passkey account settings translations**

In `shell/i18n/en.i18n.json`, inside the `accounts.accountSettings` section, add:

```json
"passkey": {
  "title": "Passkeys",
  "noPasskeys": "No passkeys registered.",
  "addButton": "Add passkey",
  "renameButton": "Rename",
  "removeButton": "Remove",
  "saveButton": "Save",
  "cancelButton": "Cancel",
  "added": "Added",
  "lastUsed": "last used"
},
```

- [ ] **Step 5: Commit**

```bash
git add shell/i18n/en.i18n.json
git commit -m "feat(passkey): add i18n translation keys for passkey admin, login, and account settings"
```

---

### Task 10: Verification and Smoke Test

- [ ] **Step 1: Verify Meteor app starts without errors**

Run: `cd shell && meteor`
Expected: App starts successfully, no import errors or crashes.

- [ ] **Step 2: Verify admin panel shows passkey provider**

Navigate to `/admin/login` in the browser. Verify the passkey provider row appears in the login provider table with a "Configure" button. Click "Configure" and verify the enable/disable modal appears.

- [ ] **Step 3: Enable passkey provider and verify login button**

Enable the passkey provider in the admin panel. Navigate to the login dropdown. Verify the "with Passkey" button appears at the top of the list. If the browser does not support WebAuthn (unlikely in modern browsers), the button should not appear.

- [ ] **Step 4: Test passkey registration from account settings**

Log in with another method (email token or dev accounts). Navigate to account settings. Verify the "Passkeys" section appears. Click "Add passkey" and complete the WebAuthn ceremony. Verify the passkey appears in the list with a friendly name.

- [ ] **Step 5: Test passkey login**

Log out. Click the "with Passkey" button. Complete the WebAuthn ceremony. Verify successful login.

- [ ] **Step 6: Test passkey rename and remove**

Navigate to account settings. Rename a passkey and verify the name updates. Remove a passkey and verify it disappears from the list.

- [ ] **Step 7: Commit any fixes**

If any issues were found during testing, fix them and commit:

```bash
git add -A
git commit -m "fix(passkey): address issues found during smoke testing"
```

---

## Dependency Graph

Tasks 1 through 2 can be done in parallel. Task 3 depends on Task 1 (npm packages). Task 4 has no dependencies. Tasks 5 and 6 depend on Tasks 3 and 4. Task 7 depends on Task 5. Task 8 and 9 can be done any time. Task 10 depends on all previous tasks.

```
Task 1 (npm deps) ──────┐
                         ├── Task 3 (server) ──┐
Task 2 (db/profile) ────┘                      ├── Task 5 (client) ── Task 7 (account settings HTML)
                                                │
Task 4 (service reg) ──────────────────────────┘
                                                     Task 10 (verification)
Task 8 (icon) ──────────────────────────────────────────────┘
Task 9 (i18n) ──────────────────────────────────────────────┘
```

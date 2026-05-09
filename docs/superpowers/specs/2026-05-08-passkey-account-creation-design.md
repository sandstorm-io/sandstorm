# Passkey Account Creation via Identifier-First Flow

**Date:** 2026-05-08
**Status:** Draft
**Scope:** Enable new account creation and login with a single passkey button using email-based server-side routing
**Builds on:** [2026-05-06-passkey-auth-design.md](2026-05-06-passkey-auth-design.md)

## Problem

The current passkey implementation only supports adding passkeys to existing accounts. Users must first sign in via another provider (Google, email, etc.) before they can register a passkey. The "with Passkey" button on the login page only triggers the authentication ceremony, which shows a confusing "insert security key" dialog when no discoverable credential exists.

## Solution

Replace the bare passkey login button with an **identifier-first flow**: an email input plus a single button. The server checks whether the email maps to an existing passkey credential and routes the client to the correct WebAuthn ceremony (authentication or registration). This mirrors the "Sign in with Google" pattern where one button handles both new and returning users.

Additionally, enable **conditional UI** (WebAuthn autofill integration) so returning users with existing passkeys can sign in directly from the email field's autofill dropdown without clicking any button.

## Login Page UI

### Current State

```
[ with Passkey ]     (bare button, triggers authentication only)
```

### New State

```
[ Email address                    ]   (autocomplete="username webauthn")
[ Continue with Passkey           ]
```

The email input has `autocomplete="username webauthn"` to enable conditional UI. On page load, the client starts `navigator.credentials.get({ mediation: "conditional" })` in the background. If the user selects a passkey from the browser's autofill dropdown, authentication proceeds immediately without clicking the button.

If conditional UI is not supported by the browser, or the user does not interact with autofill, they type their email and click the button. The server routes to the correct ceremony.

### Feature Detection

Before initializing conditional UI, check `PublicKeyCredential.isConditionalMediationAvailable()`. If it returns false or is unavailable, skip conditional UI setup. The email input and button still work normally.

## Server-Side Routing

### New Method: `passkey.initiateWithEmail(email)`

Takes an email address and determines whether to authenticate or register.

**Lookup logic:**

1. Search for credential users with this email across all auth providers:
   - `services.email.email` (email token login)
   - `services.google.email` (Google)
   - `services.github.emails.email` (GitHub)
   - `services.passkey.email` (passkey, new field)
2. For each matching credential user, find accounts that link to it via `loginCredentials.id`
3. For each matching account, check if it has a linked passkey credential (a credential user with `services.passkey`)
4. If a passkey credential is found: return `{ mode: "authenticate", options }` with `allowCredentials` populated from that user's passkey keys
5. If no passkey credential is found: return `{ mode: "register", options }` with standard registration parameters

**For registration options:**

- Generate a new `userHandle` (or reuse one if the email maps to an existing account that we'll link to later)
- Store the email alongside the challenge in the pending challenges map, so `verifyRegistrationAnonymous` can associate it later
- Use the same WebAuthn parameters as the existing `passkey.generateRegistrationOptions` method

**Privacy note:** This method reveals whether an email has a passkey registered (the client receives different ceremony types). This is accepted industry practice; Google, Microsoft, and others use the same identifier-first pattern. Rate limiting on this method is recommended to prevent enumeration.

## Registration and Login Flow (New)

### New Login Handler Branch: `passkeyRegister`

Extend the existing `Accounts.registerLoginHandler("passkey", ...)` to accept a `passkeyRegister` option in addition to the existing `passkey` option.

When `options.passkeyRegister` is present:

1. Consume the stored challenge (same as authentication)
2. Verify the registration response via `verifyRegistrationResponse()`
3. Extract credential info (credentialId, publicKey, counter, transports, deviceType, backedUp)
4. Retrieve the stored email and userHandle from the challenge data
5. Create a new credential user via `Accounts.insertUserDoc` with `services.passkey.userHandle`, `services.passkey.email`, and the key entry. (The userHandle was generated during `initiateWithEmail` and stored with the challenge. Each registration always creates a fresh credential user; account-level deduplication is handled by Sandstorm's credential linking flow, not here.)
6. Return `{ userId: credentialUserId }`

Sandstorm's existing account machinery then:
- If an account already exists with a credential linked to this email (via Google, email token, etc.): prompts the user to link the passkey credential to that account
- If no account exists: creates a new account and runs the standard onboarding flow (set name, handle, etc.)

### Client Flow

When the user clicks "Continue with Passkey":

1. Call `passkey.initiateWithEmail(email)`
2. If `mode === "authenticate"`: call `startAuthentication({ optionsJSON: options })`, then `Accounts.callLoginMethod({ methodArguments: [{ passkey: authResponse }] })`
3. If `mode === "register"`: call `startRegistration({ optionsJSON: options })`, then `Accounts.callLoginMethod({ methodArguments: [{ passkeyRegister: attestationResponse }] })` (the email is retrieved server-side from the stored challenge data, not sent by the client)
4. On success: close login overlays (same as other providers)
5. On error/cancel: show error message inline below the form

For conditional UI (autofill), the flow is the same as step 2 above, triggered by the user selecting a passkey from the autofill dropdown instead of clicking the button.

## Data Model Changes

### Email Field on Passkey Credential User

Add `services.passkey.email` to the credential user structure:

```javascript
{
  services: {
    passkey: {
      userHandle: String,
      email: String,          // NEW: email used during registration
      keys: [{ ... }]         // unchanged
    }
  }
}
```

### New Database Index

Add a sparse index on `services.passkey.email` in `db.js` for email lookup:

```javascript
Meteor.users.ensureIndexOnServer("services.passkey.email", { sparse: 1 });
```

### Challenge Storage Update

The pending challenges map entry gains an `email` field when initiated from `passkey.initiateWithEmail`:

```javascript
{
  challenge: String,
  userHandle: String | null,
  email: String | null,       // NEW: stored for registration flow
  createdAt: Number
}
```

## Modified Files

| File | Change |
|------|--------|
| `shell/imports/server/accounts/passkey/passkey-server.js` | Add `passkey.initiateWithEmail` method; extend login handler with `passkeyRegister` branch; store email in challenge data and on credential user |
| `shell/imports/client/accounts/passkey/passkey-client.js` | Replace `loginWithPasskey()` with identifier-first flow; add conditional UI initialization; handle both auth and register modes |
| `shell/imports/client/accounts/passkey/passkey-templates.html` | Replace bare button with email input + button form in `passkeyLoginForm` template |
| `shell/imports/sandstorm-db/db.js` | Add sparse index on `services.passkey.email` |
| `shell/imports/sandstorm-db/profile.js` | Include `email` in `credentialDetails` publication for passkey credentials |
| `shell/i18n/en.i18n.json` | Add translation keys for email placeholder, continue button, and error messages |

## Unchanged

- Account settings passkey management (add/rename/remove for logged-in users) stays as is
- Admin enable/disable toggle stays as is
- The existing `passkey.generateRegistrationOptions` and `passkey.verifyRegistration` methods for logged-in users stay as is
- The existing authentication path in the login handler stays as is (the `passkey` option still works for conditional UI and direct authentication)

## Security Considerations

- **Email enumeration:** `passkey.initiateWithEmail` reveals whether an email has a passkey. This is the accepted tradeoff for identifier-first flows. Apply rate limiting per connection.
- **Email verification:** The email stored on the passkey credential is self-asserted (not verified via email link). This matches how Google OAuth emails are treated in Sandstorm. The email is used for routing, not as proof of ownership.
- **Challenge binding:** Challenges remain bound to `connection.id` and are single-use.
- **Conditional UI security:** `mediation: "conditional"` only surfaces credentials when the user interacts with the autofill dropdown. It cannot be triggered programmatically.

# Meteor 3 Migration Checklist

This checklist defines the upgrade path from `METEOR@2.16` to the latest Meteor 3 release, with hard acceptance gates between major steps.

## Scope

- Main app: `shell/`
- Test app: `meteor-testapp/`
- Current release: `2.16`
- Target release: latest Meteor 3 patch release (verify before execution)

## Canonical references

- Meteor 3 migration docs: <https://v3-migration-docs.meteor.com/>
- Meteor history / release notes: <https://docs.meteor.com/history>
- Meteor releases: <https://github.com/meteor/meteor/releases>

## Hard acceptance gate

Run this command and require pass status before moving to the next major step:

```bash
PATH=~/.meteor:~/src/ekam/bin:$PATH PYTHON=python3.10 make test
```

Project notes:

- Known successful baseline signature:
  - `✨ PASSED. 1010 total assertions (5m 37s)`
- On failures, the test harness prints substantial server logs at the very end. Preserve and inspect tail output.
- To run a single acceptance test under `tests/`, use:

```bash
PATH=~/.meteor:~/src/ekam/bin:$PATH PYTHON=python3.10 TESTCASE="apps/ip-networking.js" make test
```

## Phase 0: Baseline and branch setup

### Tasks

- Create a dedicated migration branch.
- Record current Meteor/toolchain versions.
- Run and record baseline acceptance results on `2.16`.
- Create a dependency compatibility matrix for:
  - Atmosphere packages in `shell/.meteor/packages`
  - NPM dependencies in `shell/package.json` and app-local package manifests

### Exit criteria

- Baseline test command passes on `2.16`.
- Compatibility matrix is complete with status for each dependency: `compatible`, `needs update`, `replace/fork`, or `remove`.
- Baseline acceptance result recorded: `✨ PASSED. 1010 total assertions (5m 37s)`.

## Phase 1: Async pre-migration on Meteor 2.16

Goal: remove Fiber-era patterns before any Meteor major bump.

### Tasks

- Replace `fibers` / `fibers/future` usage with `async/await`.
- Replace `Meteor.wrapAsync(...)` call sites with native promise-based APIs.
- Convert server-side sync Mongo usage to async Meteor Mongo APIs where required by Meteor 3.
- Replace server sync `Meteor.call(...)` assumptions with `await Meteor.callAsync(...)`.
- In shared client/server modules, preserve client sync behavior (Minimongo) and branch server-only async paths with `Meteor.isServer`.
- Remove explicit `fibers` dependency from `shell/package.json` once code no longer depends on it.

### Hotspots to prioritize

- `shell/imports/server/migrations.js`
- `shell/imports/server/pre-meteor.js`
- `shell/imports/server/email.js`
- `shell/imports/server/networking.js`
- `shell/imports/server/accounts/ldap.js`
- `shell/imports/server/accounts/saml/saml-server.js`
- `shell/imports/blackrock-payments/server/payments-server.js`
- `shell/imports/server/gateway-router.js`

### Exit criteria

- No runtime dependency on `fibers`.
- Fiber/Future/wrapAsync usage removed or explicitly justified and compatible.
- Acceptance test command passes on `2.16`.

## Phase 2: Upgrade to Meteor 3.0.x

### Tasks

- Update `shell/.meteor/release` to latest `3.0.x` patch.
- Resolve package version constraints and update `.meteor/versions`.
- Fix breakages introduced by Meteor 3.0 core changes.
- Keep changes minimal and focused on compatibility.

### Exit criteria

- App starts and core flows are manually smoke-tested.
- Acceptance test command passes.

## Phase 3: Upgrade to Meteor 3.1.x (Express migration)

### Tasks

- Update to latest `3.1.x` patch.
- Apply Express migration guidance from Meteor migration docs.
- Migrate custom `WebApp`/Connect integration points, especially:
  - `shell/imports/server/pre-meteor.js`
  - `shell/imports/server/accounts/saml/saml-server.js`
- Verify middleware ordering and request/response behavior.

### Exit criteria

- Auth, routing, and custom middleware behavior match baseline expectations.
- Acceptance test command passes.

## Phase 4: Upgrade to Meteor 3.2.x

### Tasks

- Update to latest `3.2.x` patch.
- Apply incremental package and runtime fixes.

### Exit criteria

- Acceptance test command passes.

## Phase 5: Upgrade to latest Meteor 3 patch

### Tasks

- Upgrade from `3.2.x` to latest Meteor 3 patch (for example `3.3.x` or newer).
- Apply migration items specific to this target release from `docs.meteor.com/history`.
- Re-check package compatibility and remove obsolete workarounds.

### Exit criteria

- Acceptance test command passes.
- No known blocker remains in compatibility matrix.

## Phase 6: Staging validation and release readiness

### Tasks

- Deploy candidate build to staging.
- Run full acceptance suite in staging-equivalent environment.
- Perform focused manual smoke tests:
  - Login providers (OIDC/SAML/LDAP where applicable)
  - Grain/session sharing flows
  - Background jobs and migrations
  - Payments paths (if enabled)
- Prepare rollback notes and artifact references.

### Exit criteria

- Acceptance test command passes on release candidate.
- Rollback path tested and documented.

## Recommended sequence and gates

1. Phase 0 (baseline) -> run acceptance gate.
2. Phase 1 (async/fibers removal on `2.16`) -> run acceptance gate.
3. Phase 2 (`2.16 -> 3.0.x`) -> run acceptance gate.
4. Phase 3 (`3.0.x -> 3.1.x`, Express migration) -> run acceptance gate.
5. Phase 4 (`3.1.x -> 3.2.x`) -> run acceptance gate.
6. Phase 5 (`3.2.x -> latest 3.x`) -> run acceptance gate.
7. Phase 6 (staging readiness) -> run acceptance gate.

## Tracking template (copy per phase)

- Owner:
- Branch:
- Start date:
- End date:
- Changeset/PR:
- Risks discovered:
- Mitigations:
- Acceptance gate result:
- Follow-ups:

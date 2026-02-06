# Meteor 3 Migration Issue/PR Checklist

Use this template in a GitHub issue or PR description to track migration execution from `METEOR@2.16` to latest Meteor 3.

## Acceptance Gate Command

```bash
PATH=~/.meteor:~/src/ekam/bin:$PATH PYTHON=python3.10 make test
```

Notes:

- Baseline success signature: `✨ PASSED. 1010 total assertions (5m 37s)`.
- Failure runs emit substantial server logs at end of output; include tail logs in issue/PR evidence.
- Single-test mode example:

```bash
PATH=~/.meteor:~/src/ekam/bin:$PATH PYTHON=python3.10 TESTCASE="apps/ip-networking.js" make test
```

## Meta

- [ ] Owner assigned
- [ ] Migration branch created
- [ ] Links added to tracking issue/PRs

## Phase 0: Baseline

- [ ] Confirm current versions (`shell/.meteor/release`, `meteor-testapp/.meteor/release`)
- [ ] Build dependency compatibility matrix (Atmosphere + NPM)
- [ ] Run acceptance gate on `2.16`
- [ ] Record baseline test result artifact/log

## Phase 1: Async/Fibers Pre-Migration on 2.16

- [ ] Remove `Future` / `fibers/future` usage
- [ ] Remove `Meteor.wrapAsync(...)` usage
- [ ] Convert server sync Mongo calls to async APIs where required
- [ ] Replace sync server `Meteor.call(...)` assumptions with `await Meteor.callAsync(...)`
- [ ] In shared modules, keep client Minimongo sync code and gate server async code behind `Meteor.isServer`
- [ ] Remove `fibers` dependency when no longer needed
- [ ] Run acceptance gate
- [ ] Regressions fixed before version bump

## Phase 2: Upgrade to 3.0.x

- [ ] Set Meteor release to latest `3.0.x`
- [ ] Resolve package constraints and lockfile/versions updates
- [ ] Smoke test app startup + core flows
- [ ] Run acceptance gate

## Phase 3: Upgrade to 3.1.x (Express Migration)

- [ ] Set Meteor release to latest `3.1.x`
- [ ] Apply Express migration changes
- [ ] Validate custom middleware/request handler behavior
- [ ] Re-test auth/routing critical paths
- [ ] Run acceptance gate

## Phase 4: Upgrade to 3.2.x

- [ ] Set Meteor release to latest `3.2.x`
- [ ] Apply incremental compatibility fixes
- [ ] Run acceptance gate

## Phase 5: Upgrade to Latest 3.x Patch

- [ ] Set Meteor release to latest Meteor `3.x` patch
- [ ] Apply release-specific migration items from Meteor history/docs
- [ ] Remove temporary migration workarounds no longer needed
- [ ] Run acceptance gate

## Phase 6: Staging Readiness

- [ ] Deploy release candidate to staging
- [ ] Run acceptance gate in staging-equivalent environment
- [ ] Execute manual smoke tests (auth, sharing, background jobs, payments if enabled)
- [ ] Validate rollback procedure
- [ ] Sign-off for production rollout

## Hotspot Checklist

- [ ] `shell/imports/server/migrations.js`
- [ ] `shell/imports/server/pre-meteor.js`
- [ ] `shell/imports/server/email.js`
- [ ] `shell/imports/server/networking.js`
- [ ] `shell/imports/server/accounts/ldap.js`
- [ ] `shell/imports/server/accounts/saml/saml-server.js`
- [ ] `shell/imports/blackrock-payments/server/payments-server.js`
- [ ] `shell/imports/server/gateway-router.js`

## Evidence / Links

- Baseline acceptance log:
- Phase 1 acceptance log:
- Phase 2 acceptance log:
- Phase 3 acceptance log:
- Phase 4 acceptance log:
- Phase 5 acceptance log:
- Phase 6 acceptance log:
- Migration docs consulted:
- Open follow-up issues:

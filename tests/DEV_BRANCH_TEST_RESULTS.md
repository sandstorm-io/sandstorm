# Sandstorm Dev Branch Bug Report

Reported by: HojoonM77
Date: August 23, 2026
Branch: dev
Environment: AWS EC2 t3.small, Ubuntu 26.04 LTS x86-64
Chrome: 144.0.7559.133 | ChromeDriver: 144.0.7559.109 | Nightwatch: 2.6.0
Sandstorm: installed via install.sh, running on port 6080

Test results summary:
- PASS: basic.js (partial), restore-open-grains.js (24/24)
- FAIL: sharing.js, trash.js, backup-restore.js (Bug 1)
- FAIL: autoupdate.js (Bug 2)
- FAIL: account-settings.js, account-settings-extended.js (Bug 3)
- NOT RUN: grain.js, account.js (no demo mode), appHooks/system-api/schedule/web-publishing (no .spk files)

---

## Bug 1 - Grain iframe content fails to load [HIGH]

Affected: sharing.js, trash.js, backup-restore.js

The grain frame iframe loads and is visible but content inside never renders.
Affects multiple apps (ssjekyll8.spk, test-0.spk) so not app-specific.
restore-open-grains.js uses the same app and passes because it never reads
content inside the grain frame, only navbar tabs.

Server log shows repeated errors when grain content is requested:

    Error: remote exception: stream disconnected prematurely
    at getUiViewAndUserInfo (imports/server/gateway-router.js:248:6)
    at GatewayRouterImpl.openUiSession (imports/server/gateway-router.js:289:12)
    kjType: disconnected

The gateway router is disconnecting before grain content can be served.
DNS is correctly configured (*.local.sandstorm.io resolves to 127.0.0.1)
so this is not a DNS/routing issue.

Test evidence:
    Element iframe.grain-frame was present after 8 milliseconds.
    Element #grain-frame-5KS5Dwajhu66y6mrYx5Xbc was visible after 23 milliseconds.
    Timed out while waiting for element #publish for 30000 milliseconds.

---

## Bug 2 - App update notifications not appearing [MEDIUM]

Affected: autoupdate.js

Meteor.call('fetchAppIndexTest') executes without error but the notification
badge never appears after 60 seconds. Likely caused by IS_TESTING=true missing
from sandstorm.conf - this flag is required for test-only Meteor methods to be
available. Our Sandstorm was installed manually rather than via run-local.sh
which adds IS_TESTING=true automatically.

Current sandstorm.conf is missing:
    IS_TESTING=true
    ALLOW_DEMO_ACCOUNTS=true

Test evidence:
    Timed out while waiting for element .topbar .notifications .count
    for 60000 milliseconds. expected visible but got not found.

---

## Bug 3 - disableGuidedTour() race condition [LOW - test only]

Affected: account-settings.js, account-settings-extended.js

disableGuidedTour() sets Session variables but does not wait for
div.introjs-overlay to be removed from the DOM. Chrome 144 renders faster
than previous versions so the overlay remains with opacity:0 and intercepts
the next click. Not reproducible by a real user.

Server log confirms this is test-only - no server-side errors produced.

Test evidence:
    element click intercepted: button.has-picture is not clickable.
    Other element would receive the click: div.introjs-overlay opacity:0

Suggested fix in commands/disableGuidedTour.js - add after execute():
    .waitForElementNotPresent("div.introjs-overlay", utils.short_wait)

---

## Deprecation Warning [LOW]

Affected: basic.js

    DEPRECATED: .title() will be removed. Use assert.titleEquals().

Fix: change .assert.title('Sandstorm') to .assert.titleEquals('Sandstorm')

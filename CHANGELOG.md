### v0.120 (2015-10-15)
- Fix bug causing intermittent timeouts in web publishing.

### v0.119 (2015-10-15)
- Sandstorm now notifies you when app updates are available.
- A few days after installing Sandstorm, it will ask you for permission to send anonymous usage stats back to us. The stats sent are a subset of what appears at /admin/stats, so you can inspect them for yourself.
- Apps can now expose WebDAV APIs. This will soon be used to support Dropbox-like file sync.
- Large under-the-hood changes have been made towards the goal of supporting multiple login methods for the same account, but these changes should not yet be user-visible unless there are bugs.
- Fix bug where file upload dialogs (e.g. profile picture, spk upload, etc.) would sometimes randomly do nothing after a file was chosen.
- Page title is now correctly updated when browsing to a non-grain route.
- HTTP proxy now passes through ETags and ETag preconditions, probably improving performance for some apps.
- Attempt again to fix rare bug where front-end stops talking to back-end, apparently not fixed by 0.116 as we thought. Most likely still not fixed, but new logging has been added to try to debug.

### v0.118 (2015-10-07)
- Fixed problem where Sandcats-HTTPS-enabled servers would request new certificates too often.
- This is a cherry-pick release -- no other changes merged in the last week are included.

### v0.117 (2015-09-30)
- Self-hosters using Sandcats now get automatic free HTTPS certificates. This is normally set up automatically during install. If you first installed before this release, [see the docs to find out how to enable HTTPS](https://docs.sandstorm.io/en/latest/administering/ssl/).

### v0.116 (2015-09-29)
- (Probably) fix very rare bug in which front-end stops talking to back-end causing grains to fail to load until the next front-end restart. The bug was in node-capnp's use of libuv.
- Check PGP signatures on packages on install and store them in the database (not yet surfaced in UI).

### v0.115 (2015-09-24)
- Attempt to work around very rare problem where front-end inexplicably stops talking to back-end by monitoring and recreating the connection.
- Oasis: Fix "download backup", which broke due to unexpected interaction between security hardening to the sandbox in which zip/unzip runs and security settings on Oasis.

### v0.114 (2015-09-23)
- No-op release just to test end-to-end that the new signed update mechanism works. (We did lots of tests in advance, but touching the updater code always makes me nervous, so test again!)

### v0.113 (2015-09-23)
- The installer script is now PGP-signed such that it can be verified by third parties without relying on the integrity of HTTPS.
- The installer now verifies downloads using GPG (in addition to using HTTPS as it always has).
- Updates are now verified using libsodium ed25519 signatures (in addition to being downloaded over HTTPS as they always have).
- Oasis: Fixed storage bug that was causing random app restarts (but no data loss).
- Various small UI usability tweaks.

### v0.112 (2015-09-16)
- Fix another stats bug causing stats recording to sometimes be interrupted by an exception.

### v0.111 (2015-09-16)
- Fix bug preventing "who has access" table from displaying properly.

### v0.110 (2015-09-16)
- Fix problem with display of app stats (in admin panel) in presence of broken package uploads.

### v0.109 (2015-09-15)
- You now uninstall apps again.
- Suspending your machine for a few minutes or more and then resuming will no longer cause all your open Sandstorm grains to stop working until you reload them.
- Fixed brief display of "Reveal your identity?" prompt when loading your own grains (where this prompt makes no sense).
- Clicking on an app in the app list will now immediately show the loading spinner without waiting for the server to respond. (Previously, when the server was overloaded, there could be a delay with no feedback. People would often click the app repeatedly, causing multiple grains to be created.)
- Worked around bogus Adblock Plus rule that blocked parts of the sharing "who has access?" UI.
- Better accessibility for non-visual users.
- Readability improvements.
- You can now close popups by pressing "escape".
- In the grain list, you can now type an app title to filter for grains of that app.
- More detailed stats gathering, particularly app-specific stats (see "stats" in the admin UI).
- Refactored permissions code into a package with better tests.
- Oasis: Fixed problem where a particular app package might occasionally become broken on a particular worker machine, especially popular apps. The most common symptom was Etherpad or Wekan sporatically failing to load even in new grains, often fixed by restarting the grain (but not by simply reloading the page), since this pushed it to a different worker. No user data was damaged by this problem.

### v0.108 (2015-09-03)
- Oasis: Allow front-ends to be parallelized so that they can scale to arbitrary load.
- Eliminated redundant subscriptions and added caching to reduce front-end load.
- Placed grain title first in title bar, rather than app title.
- Updated wording of app install prompt.

### v0.107 (2015-08-31)
- Fix sign-out button.

### v0.106 (2015-08-30)
- Complete UI overhaul!
  - "New" and "Open" flows.
  - Ability to have multiple grains open at once and fast-switch between them.
  - Icons.
  - Better design all around.
- App market launch!
- Sandstorm Oasis is now in Open Beta with self-serve signup. (Self-hosted servers still use invite system.)
- Demo server is now Oasis, and demo accounts can upgrade to full accounts. (Demo mode remains off by default for self-hosters.)

### v0.105 (2015-08-14)
- The sharing UI can now directly send email with a sharing link, and has been reorganized. (More updates are coming in the next release.)
- The new app metadata format has been improved (in backwards-incompatible ways, but it wasn't being used yet).
- New `spk publish` command can publish apps to the upcoming app market.
- `spk verify --details` will now check the package's PGP signature if present and display the key ID.
- Fixed bug preventing first-time login through Github using a Github account that had no display name set.
- Fixed bug where logging in while viewing a sharing link did not correctly update the app to notify it that the user was now logged in.
- Lots of code refactoring in preparation for big changes coming soon.

### v0.104 (2015-08-03)
- Fix sudden increase in log spam in 0.102 -- unnecessarily large full-HTML DNS TXT lookup error messages were being logged to the console; no more. In fact, now these are properly 404 errors as they should be.

### v0.103 (2015-08-03)
- Emergency fix for bug that can cause startup failure in the presence of users that apparently have a `services` entry but no `profile`. The alpha server seems to have these but none of the test servers did.

### v0.102 (2015-08-03)
- New icons designed by Nena!
- New account settings page allows setting display name, profile picture, preferred handle, and preferred pronouns, all of which are passed on to apps. These are auto-populated from the login provider as much as possible.
- App packages may now include metadata like icons, license information, description, screenshots, and more, for use in the Sandstorm UI and upcoming app market. Large blobs embedded this way (e.g. images) will be extracted and served via a new static asset serving subsystem with high cacheability (also used for profile pictures).
- You may now configure Sandstorm to run on port 80. The socket is bound before dropping privileges and passed into the front-end via parent->child file descriptor inheritance.

### v0.101 (2015-07-25)
- Refactored CSS styling and accounts drop-down code. Please be on the lookout for bugs.
- Fixed bug where the admin settings page would simply say "Loading..." forever if the user was not authorized.

### v0.100 (2015-07-22)
- Fix inability to configure Google/Github login accidentally introduced in v0.97 during security tightening.
- Add missing changelog for 0.99.

### v0.99 (2015-07-21)
- Fix app scrolling on iOS.
- Fix popups being onclosable on iOS.
- Fix app selection on mobile.

### v0.98 (2015-07-19)
- Fix grain title misalignment on Firefox.

### v0.97 (2015-07-19)
- Revamped design of menus hanging off top bar. Now much less ugly! Plus the login menu is consistent with everything else!
- Major internal refactoring of topbar UI. Please be on the lookout for bugs.
- Mobile UI hamburger menu contents are now more complete and contextually correct (due to topbar UI refactoring).
- Fixed loading spinner in case where grain fails to start.
- Fixed bugs where transitive shares wouldn't grant access.
- Finally added "new" code devs to "about" page.

### v0.96 (2015-07-14)
- Loading spinner is back, hopefully non-buggy this time.
- Fixed regression in web publishing that caused sites to be cached for 30000 seconds instead of the intended 30 seconds.
- Refactored sharing permissions computation.
- Introduced admin UI for creating raw IP networking capabilities, which can be passed into apps.
- Offer templates can now specify that the offered token is meant to be used by users other than the creating user, like sharing tokens.

### v0.95 (2015-07-11)
- Reverted "loading" spinner because it interacted badly with the "reveal your identity?" interstitial.

### v0.94 (2015-07-11)
- Oasis: Storage usage and quota is now tracked and enforced.
- We now display a spinner when apps are slow to start up. (But we are working on making apps start faster!)
- Offer templates now work for anonymous users, and the tokens do not expire as long as the template is still displayed.
- Long admin alerts should now avoid covering the top bar controls.
- When copy/pasting a token for email login, whitespace is now ignored.
- When restoring a backup fails, we now delete the just-unpacked data rather than leak the story.
- Fixes and improvements to sharing implementation details.

### v0.93 (2015-07-06)
- Grain logs can now be viewed even when the grain has died.
- The RoleAssignments table was merged into the ApiTokens table. This should have no visible effect but is a major implementation change in sharing.
- Webkeys (for connecting external client apps to a grain) now default to granting all of your access (to that grain), rather than a specific role (e.g. read/write). You can still select a specific role if you wish.
- Bug: In 0.92, web publishing regressed by no longer specifying a charset in the `Content-Type` header, causing browsers to default to LATIN-1 (eww). It now specifies UTF-8 as it did originally. Web sites that set the charset in a &lt;meta> tag (as most do) were not affected.

### v0.92 (2015-06-28)
- First pass of powerbox UI: Apps can now offer and request capabilities, resulting in direct Cap'n Proto RPC connections between apps, including the ability to save and restore these capabilities for later use. Currently, the user must copy/paste a token from the offering app to the requesting app, but this will eventually be replaced with a picker UI.
- Web publishing (as in, the feature used by Wordpress, Ghost, and HackerCMS apps) should now work on Sandstorm Oasis (managed hosting).
- Added support for APIs to opt-in (from the client side) to revealing their public IP to the server app. Needed for Piwik.
- Improved display of admin alerts on mobile.
- Admin alerts can now include the current app name in their text and link; useful for clickthrough metrics.

### v0.91 (2015-06-20)
- Bug: The first bug in v0.90 was not fully fixed: query parameters and fragments were still being dropped. This is blocking a thing, so we're pushing another fix. Sorry.

### v0.90 (2015-06-20)
- Bug: Share links with paths would lose the path if the user was logged in and consumed the link (redirecting them to /grain/whatever). The path is now preserved in this redirect.
- Bug: The API by which apps set paths did the wrong thing when viewing anonymously via a share link: it would overwrite the URL with a /grain URL, which would lead to an unauthorized error if the user refreshed.
- Bug: On server restart/upgrade, logged in users viewing grains not owned by them had their view force-reloaded. Buggy code perceived the user's permissions to be changing.
- Bug: On server restart/upgrade, anonymous users viewing share links would not be force-reloaded, but would find that the iframed app stopped working and started giving 404s instead. This is because session hosts were not restored correctly for anonymous users.

### v0.89 (2015-06-20)
- "Incognito" sharing: Sandstorm will now ask you whether you want to reveal your identity when visiting a share link from someone you haven't interacted with before.
- When you have no grains, a big green arrow will now suggest that you install an app or create a grain. (Helps users get through the demo.)
- Apps can now receive callbacks from Github webhooks via the API endpoint.
- Share links can now include paths (e.g. to make them go to a specific page on MediaWiki).
- Fixed unexpected page refreshes when using apps that support paths (like MediaWiki).
- "Admin alert" feature lets you define a banner to show to all users, possibly including a time and countdown, e.g. to announce scheduled downtime.
- Various Admin panel usability improvements.

### v0.88 (2015-06-18)
- Fix real-time activity stats not being displayed (in admin settings).
- Fix issue on Oasis where worker could get into a bad state and refuse to start grains.

### v0.87 (2015-06-13)
- Emergency fix to race condition which caused the login control to claim no login services were configured when communicating with a server far-away on the network. This wasn't caught in testing because we usually test against localhost servers. The fix is to make the list of enabled services reactive, where it wasn't before. This update should entirely resolve the problem.

### v0.86 (2015-06-13)
- New API allows apps to stay running in the background. The user is notified and can cancel the background processing to avoid expending resources. A notifications box has been added to the UI; eventually, other notifications will arrive here too, but for now it's just for background processing.
- New API allows apps to render an "offer template", which is a chunk of instructional text containing an embedded API token suitable for copy/pasting e.g. into a shell. This will be used, for example, to improve the UX for Gitweb and Gitlab so that you can set up your git client by copy/pasting sample commands. The app can display such a template without ever getting direct access to the API token text, which would otherwise be a violation of confinement.
- Backup/restore functions now go through the backend API rather than having the front-end directly operate on the filesystem. The zip and unzip processes are additionally more tightly sandboxed than before.
- Admin panel now includes usage stats and a view of the server log file.
- `spk pack` now avoids creating excessive numbers of mmap()s (which vbox shared folders don't like).
- Admin user list now shows the email address or invite notes under which the user was invited.
- Various installer UX improvements, especially in failure cases.

### v0.85 (2015-06-01)
- Added this change log, and made it appear on the "about" page.
- Updated to latest Meteor.
- Improved `spk pack` performance by using multiple compression threads.
- Bugfix: Sending invides in admin settings now works with emergency admin token login.
- Bugfix: Don't display irrelevant webkey button to users who can't use it.
- Bugfix: When testing SMTP, use the newly-input configuration rather than the saved configuration.
- Bugfix: Fix permissions on various disk directories so that the `sandstorm` group can access them.

### v0.84 (2015-05-24)
- Fix admin-token ownership; when created as root
- Support standalone spk binary

### v0.1-v0.83
- Change logs were not kept, but you can inspect the release tags in git.

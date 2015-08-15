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

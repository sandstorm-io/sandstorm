### v0.181 (2016-09-10)
- Sandstorm for Work: Feature keys now automatically renew when they expire. If automatic renewal isn't possible, the administrators will receive notifications by bell menu and (if possible) e-mail.
- Added hardening against clickjacking and CSRF attacks on apps. On Chrome and Safari, CSRF attacks should now be totally blocked, even if the app fails to implement proper protections.
- Fixed that newly-received shares were appearing at the bottom of the grain list using the default sort order (by last-opened date). Never-opened grains will now sort according to the share date, and will show "Unopened" in the last-opened column.
- Fixed bug in Meteor that could cause the server to suddenly spawn tens of thousands of fibers, which in turn due to a bug in V8 would make the server permanently consume excessive CPU, even after the fibers exited.
- Fixed that the "stay anonymous" button on the sign-in hint didn't work (but closing the hint dialog worked and had the same effect).
- Fixed that after manually updating an app, the button to upgrade existing grains did not appear. (When auto-updating an app via the notifications menu, grains are updated automatically.)
- Fixed grain tab close buttons sometimes being the wrong size on new builds of Chrome.
- Fixed some console log spam.
- Various refactoring.
- Updated all dependencies.

### v0.180 (2016-09-03)
- The "Who has access" dialog now shows collections of which the grain is a part, and (more generally) other grains through which this grain has been shared.
- The "Delete Account" button now makes you type a phrase to confirm. (It still doesn't actually delete your account for 7 days.)
- When a user deletes their own account, they will now receive an e-mail notification, in case of hijacking.
- The "Sandstorm for Work" section of the admin panel now contains a direct link to manage your feature key's billing preferences.
- Added `spk dev --proc` flag which requests that `/proc` be mounted in the sandbox for debugging purposes. This may decrease security of the sandbox, so is only allowed in dev mode.
- The account settings page now looks reasonable on mobile.
- Fixed grains in trash sometimes missing icon and other app details.
- Setting a BASE_URL with a trailing slash will no longer subtly break things.
- Dropping a SturdyRef not owned by the calling grain will now act as if the SturdyRef doesn't exist rather than throwing an exception. This particularly affects grains that have been backup/restored and so have someone else's tokens in their storage.
- HTTP API requests will no longer throw an exception if the user-agent header is missing.
- sandstorm-http-bridge will now log a note if the app doesn't seem to be coming up on the expected port.
- Oasis: Added self-monitoring and auto-restart for the ["fiber bomb" problem](https://github.com/meteor/meteor/issues/7747). Also added instrumentation to track down root cause.

### v0.179 (2016-08-26)
- A user can now request deletion of their own account, unless they are a member of a Sandstorm for Work organization. Deletion has a 7-day cooldown during whith the user can change their mind.
- Admins can now suspend and delete accounts from the admin panel.
- Apps can now request that an offer template be a link with a special protocol scheme that can trigger a mobile intent, allowing one-click setup of mobile apps. Apps will need to be updated to take advantage of this.
- Identity capabilities now have a getProfile() method, allowing a grain to discover when a user's profile information has changed without requiring the user to return to the grain.
- Fixed that admins were unable to un-configure SMTP after it had been configured.
- Fixed problems in sandstorm-http-bridge that could make notifications unreliable. Affected apps will need to rebuild.
- Increased expiration time for uploading a backup from 15 minutes to 2 hours, to accommodate large backup files on slow connections.
- Fixed email attachments from apps having incorrect filenames.
- Fixed various styling issues.
- Various ongoing refactoring.

### v0.178 (2016-08-20)
- The grain list can now be sorted by clicking on the column headers.
- Many improvements to mobile UI. (Still more to do.)
- Your current identity's profile picture now appears next to your name in the upper-right.
- Fixed desktop notifications displaying grain titles incorrectly.
- Fixed `spk publish` throwing an exception due to a bug in email handling.
- Improved accessibility of "Sandstorm has been updated - click to reload" bar.
- When an app returns an invalid `ETag` header, sandstorm-http-bridge will now log an error and drop it rather than throw an exception.
- Updated to Meteor 1.4.1.
- Oasis: Fixed appdemo not working for Davros.

### v0.177 (2016-08-15) [bugfixes]
- Changes to SMTP handling in v0.175 caused Sandstorm to begin verifying TLS certificates strictly. Unfortunately, the prevailing norm in SMTP is loose enforcement and many actual users found Sandstorm no longer worked with their SMTP providers. This update therefore relaxes the rules again, but in the near future we will add configuration options to control this.

### v0.176 (2016-08-13) [bugfixes]
- Fix web publishing to alternate hosts, broken by an API change in Node.

### v0.175 (2016-08-13)
- Grain sizes now appear on the grain list.
- Added `sandstorm uninstall` shell command.
- Upgraded to Meteor 1.4 and Node 4.
- Sandcats: HTTPS connections now support ECDHE forward secrecy (as a result of the Node upgrade). Qualys grade increased from A- to A.
- Bell-menu notifications now also trigger desktop notifications.
- The collections app has been added to the default preinstall list for new servers. (We highly recommend existing servers add it in the admin settings, too.)
- No apps will be automatically installed on dev/testing servers (e.g. vagrant-spk).
- Switched to newer, better mail-handling libraries.
- Fixed the "close" button on the email self-test dialog.
- Fixed the "dismiss" button on notifications behaving like you'd clicked the notification body.
- Errors during a powerbox request will now be shown on-screen rather than just printed to the console.
- Fixed that uploading a backup left a bogus history entry, breaking the browser's back button.
- Fixed powerbox search box, which was apparently completely broken.

### v0.174 (2016-08-05)
- Admins can now choose to pre-install certain apps into new user accounts. For all new servers and Oasis, our four most-popular apps will be pre-installed by default: Etherpad, Wekan, Rocket.Chat, and Davros. Admins can disable this if they prefer, and servers predating this change will not pre-install any apps by default (but the admin can change this).
- offer()ing a grain capability now works for anonymous users, which means anonymous users can use the collections app. This app will be officially released shortly.
- Identicons are now rendered as SVGs rather than PNGs, which makes them much more efficient to generate. This in particular fixes the noticeable pause when the sharing contact auto-complete first appears for users who have many contacts.
- Updated to Meteor 1.3.5.1 (1.4 / Node 4 coming soon!).
- Fixed that Sandstorm sometimes temporarily incorrectly flashed "(incognito)" in place of the user name when starting.
- Sandstorm for Work: Non-square whitelabel icons now do something reasonable.
- Various refactoring.
- Somewhat improved styling of bell-menu notifications. (More work to be done.)

### v0.173 (2016-07-23)
- Sandstorm for Work: Added server whitelabeling features. Find under "Personalization" in the admin panel.
- Apps now receive profile pictures for all users. Users who have no picture get an identicon. Previously, apps were expected to generate identicons themselves.
- HTTP requests to / responses from apps now pass through any header prefixed with `X-Sandstorm-App-`. Also, `X-OC-Mtime` is whitelisted in responses, to improve Davros' compatibility with ownCloud clients.
- Attempting to download a backup of a collection will show a warning explaining that this doesn't do what you expect.
- Prevented guests from uploading grain backups. These uploads weren't creating actual grains, but could use up server-side disk space.
- Fix bug in grainlist deduplification on app details page.
- Fixed that the admin page for managing a specific user only showed their login identities, not non-login identities. The main list showed both, but the non-login identities would disappear when clicking through to a specific user.
- The favicon is now transparent instead of white-background.
- The guided tour highlight of the "share access" button no longer blacks out the button on Firefox.
- The admin UI's "Personalization" page no longer fails to save if you haven't entered a Terms of Service or Privacy Policy URL.
- "204 No Content" responses from apps now preserve the ETag.
- Refactored powerbox client-side code to make it more pluggable.

### v0.172 (2016-07-15) [bugfixes]
- Fixed a regression that caused accepting an app update notification to have no effect. Sandstorm will re-notify about missed updates within 24 hours.
- Fixed bugs preventing Sandstorm from working on IE10.
- Tweaked new activity event API.
- Major refactor of powerbox-related code.
- Bugfixes related to upcoming collections app.

### v0.171 (2016-07-09)
- **Activity/Notifications API:** Apps can now inform Sandstorm when a grain has been modified. Sandstorm will then highlight the grain in the user interface to show that it has new content, and in some cases deliver notifications to interested users. Apps need to be updated to use the API, but an update to Etherpad will ship on Sunday with updates to Rocket.Chat and Wekan soon thereafter.
- Fixed regression where grain UIs would not refresh when the grain's package was updated.
- Fixed bug where it was possible to have a "shared with me" copy of a grain you own show up in your grain list, which in turn caused other bugs.
- Fixed spurrious deprecation warning in server logs and reduced the size of the Sandstorm bundle by 10% by eliminating redundant copies of the Connect framework which were being included due to npm dependency semantics.
- Fixed some modal dialogs stretching off the screen on mobile.
- Various code refactoring.
- Oasis: Fixed that save()ing a capability was producing a SturdyRef that could not be restored due to bookkeeping errors.
- Sandstorm for Work: The SAML XML blob is now available even if the SAML identity provider has not yet been enabled. This should make setup easier.

### v0.170 (2016-07-02) [bugfixes]
- Meteor-based apps will no longer go into redirect loops when WebSockets are not working.
- Sandstorm for Work: Fixed SAML login failing when a user's name contained non-ASCII characters.
- The Powerbox API has changed slightly to involve a server-side exchange after the client-side selection operation. This improve security. Existing powerbox-using apps will need to be updated -- but no major apps are using it yet.
- When using email login and clicking the link (rather than copy/pasting the token), you will now be redirected back to the URL from which you initiated login.
- Improved design of profile editor UI.
- The user table in the admin panel can now be sorted by clicking column headers.
- Fixed "guided tour" hint bubble for installing apps showing for users who aren't allowed to install apps.

### v0.169 (2016-06-26) [bugfixes]
- Fixed regression in static web publishing that caused requests that should have returned 404s or redirect-to-add-trailing-slash to instead return a 500 status with a blank page.
- Added ability for admin to request a heapdump (to debug memory leaks).

### v0.168 (2016-06-24) [bugfixes]
- Sandstorm for Work: SAML connector should now work with Active Directory.
- Fixed various subtle resource leaks in Sandstorm front-end and sandstorm-http-bridge.
- Fixed random crash/hang bug introduced in sandstorm-http-bridge v0.166. Apps build since that time will need to be rebuilt.
- The old admin interface has been completely removed (the new admin interface has been the default since v0.164).
- The email configuration test dialog now shows more informative error messages.
- The "most-used" apps row is now only shown if you have more than 6 apps, without which it isn't helping.
- Added "guided tour" hint highlighting the "share access" button.
- Added explanatory text to admin user invite page.
- Fixed search bar autofocus on app list page.
- The question mark info button on Grains page was supposed to have a circle around it.

### v0.167 (2016-06-18) [bugfixes]
- Updated to Meteor 1.3.3.1.
- Implemented hard flow control at the Cap'n Proto layer so that an errant (or malicious) app cannot cause excessive memory use elsewhere in the system by making excessive simultaneous calls. This should improve the stability of Oasis.
- Implemented flow control for uploads to an app (though it rarely comes into play unless running Sandstorm locally).
- Fixed that after losing internet connectivity for a while (or suspending your laptop) and then coming back, grains would refresh.
- Fixed some memory leaks in shell server.
- Added more "guided tour" points to help new users learn Sandstorm.
- Sandstorm for Work: SAML connector now exports XML auto-configuration blob.
- Sandstorm for Work: Improved UI around feature keys.

### v0.166 (2016-06-11) [bugfixes]
- Implemented flow control for large file downloads from apps so that they don't buffer in the front-end consuming excessive RAM. Apps that handle large files will need to re-pack using the latest sandstorm-http-bridge and push an update.
- Sandstorm for Work: Made SAML entity ID configurable; added more setup instructions.
- Updated Google login setup instructions to match latest gratuitous UI changes.

### v0.165 (2016-06-04) [bugfixes]
- Re-enabled websocket self-check under new admin UI.

### v0.164 (2016-05-20)
- Self-hosting: The admin settings UI has been completely revamped.
- Fixed grain debug log auto-scrolling.
- Sandcats: Fixed obscure ASN.1 type issue in CSRs that was causing Globalsign API to complain.
- Fixed bug where logging in via Google or Github while viewing a sharing link which you had already redeemed previously would lead to an error.

### v0.163 (2016-05-15) [bugfixes]
- Fixed subtle bug introduced in 0.162 which caused shared grains to refresh every minute.

### v0.162 (2016-05-14)
- Implemented "trash". Deleted grains go to the trash where they can be recovered for up to 30 days.
- Grains can now be deleted from the grain list, without opening them first. Multiple grains can be selected for deletion at once.
- An app can now request that the "who has access" dialog be displayed.
- Fixed bug where after an upload failed, future uploads would show the same error despite not having failed.
- Tweaked the "logout other sessions" button to give better feedback that the request is in-progress.
- When visiting a Sandstorm server that hasn't been set up yet, you'll now be redirected to the setup wizard.
- The API endpoint now allows the authorization token to be specified as part of the path, for cases where setting the `Authorization` header is not possible (especially cross-origin WebSocket).

### v0.161 (2016-04-29) [bugfixes]
- API requests can now include Mercurial headers, potentially allowing a Mercurial server app.
- You can now configure Sandstorm to accept SMTP connections on low-numbered ports, such as 25.
- Apps that send email can now omit the "from" address and have it filled in automatically to the grain's auto-generated address. (Previously, the app had to explicitly call another method to find out this address.)
- Rewrote permissions algorithm to support upcoming features. Should have no visible changes currently.
- Fixed some bugs around grain renaming when a grain was received through multiple sharing links.
- Sharing emails are now included in the per-user email send limit of 50 per day.
- Oasis: Demo users can no longer send sharing invite emails, due to abuse.
- Sandstorm for Work: The SAML configuration now clearly displays the entity ID used by Sandstorm.

### v0.160 (2016-04-23) [bugfixes]
- When the owner renames a grain, the change will now be visible by people with whom the grain has already been shared.
- Sandstorm for Work: Enforce various rarely-used SAML constraints. (The important ones were already enforced.)
- Increased timeout for wildcard host self-check to try to prevent error from displaying spurriously.
- Hid "share access" button in cases where it doesn't work -- e.g. when the user doesn't have access or the grain doesn't exist.
- Fixed regression causing powerbox offers of UiViews to fail (not yet used by any real app).
- Oasis: Fixed first-grain tutorial overlay.

### v0.159 (2016-04-16)
- Sandstorm for Work: The sharing dialog auto-complete will now automatically be populated with all known members of your organization. (This can be turned off in the admin settings if the membership of your organization should be kept secret from its own members.)
- Error messages informing the user that they need to log in as a different identity now allow the identity cards to be clicked to immediately initiate login as that identity, rather than requiring the user to use the sign-in menu manually.
- Improved login provider first-time setup UI.
- Updated to Meteor 1.3.x, a major Meteor update. No changes to Sandstorm, but many dependencies have changed, possibly introducing new bugs.
- Fixed redirect loop that could happen when following a sharing link after the sharer has unlinked from their account the identity that they had used when sharing.
- Fixed that paths marked hidden in a package's `sandstorm-pkgdef.capnp` would still appear under `spk dev` when listing the parent directory (though the paths were not actually accessible).
- Sandstorm for Work: Fixed some cases where LDAP and SAML users were being handled incorrectly, such as when trying to auto-complete such users in the sharing dialog.
- Oasis: Fixed subtle storage-related bug causing a small number of grains to get stuck in an unbootable state.
- Oasis: Fixed related bug that caused grains created in the last few weeks to consume many more megabytes in a user's total storage quota than the actual size of the grain as reported in the top bar. If you feel that your total storage usage is being misreported, please try opening each of your grains created in the last three weeks to trigger a recount.

### v0.158 (2016-04-08) [bugfixes]
- Massively improved performance of `spk dev` filesystem tracing.
- Fixed that an app's SandstormCore capability could get disconnected if the frontend restarted without restarting the app, leaving the app in a state where certain features (especially powerbox-related) did not work.
- Fixed that clicking the clipboard button to copy an offer template would include extra whitespace on Firefox, which was especially bad when copying passwords e.g. from Davros.
- Stop printing spurrious warning about missing iptables module that just confused everyone.
- Sandstorm for Work: LDAP and SAML users ID cards will now show LDAP/SAML icon.
- Oasis: Increased file descriptor limits to improve reliability.

### v0.157 (2016-04-05)
- Self-hosting: New, beautiful first-time setup wizard. (Sadly, if you already have a server, you'll never see it. But a redesign of the full admin UI is coming soon.)
- Sandstorm for Work: Added ability to disallow sharing outside the organization, which also disallows guest accounts (since they only exist for external sharing purposes).

### v0.156 (2016-04-02)
- Sandstorm for Work: Added support for SAML login.
- Sandstorm for Work: LDAP identities now have email addresses.
- Sandstorm for Work: Removed the option to specify an LDAP DN pattern in favor of the search query approach. DN patterns were going to create problems for future planned features and none of our users so far used the feature to our knowledge.
- Sharing emails are now sent under the name of the sharer, with their email address specified in reply-to.
- Fixed several display bugs in Internet Explorer.
- Fixed that opening your own sharing link would sometimes prompt you to choose incognito mode.
- Fixed regression causing some popup windows to display partially-off-screen on mobile.
- Fixed minor display bugs with first-time usage tips on IE and Firefox.

### v0.155 (2016-03-27) [bugfixes]
- Remove chatty console.log() recently added for debugging. Oops.

### v0.154 (2016-03-27)
- Apps can now verify a user's email address via a Powerbox interaction.
- Apps can now more easily tell when multiple sessions originate from the same grain tab (e.g. because the user closed their laptop and then opened it later and continued using the tab). Previously the app had to save a cookie to do this, but now Sandstorm will give it a `tabId`.
- Sandstorm will now warn you in the admin panel if Websockets aren't working, which tends to break many apps.
- The Picker Powerbox's query format has changed. Queries are now specified as base64-packed-capnp rather than JSON. This is necessary since the Sandstorm system does not necessarily know the schema of these descriptors and so won't be able to perform a JSON->capnp translation itself.
- Fixed a refresh loop that could occur when visiting a sharing link that had been revoked.
- Fixed some email deliverability issues. (Envelope sender was not always being set correctly.)
- Self-hosting: Fixed possible (but obscure) exception during startup migrations introduced in 0.151.
- Sandstorm for Work: Fixed "LDAP Search Username Field" not saving.

### v0.153 (2016-03-22) [bugfixes]
- Fix blank screen when clicking through a share-by-identity email.

### v0.152 (2016-03-21) [bugfixes]
- Self-hosting: Fixed sending server invites by email (from the "send invites" tabh in the admin settings).
- Improved error message seen when static publishing TXT records are misconfigured.
- Improved error message when trying to send a sharing invite to an invalid email address.

### v0.151 (2016-03-20) [bugfixes]
- Expanded LDAP config for search-query-based user matching to support authenticating the search and adding a search filter. LDAP is nuts.
- Worked around bug in Chrome 50 which was causing app installs to sometimes fail complaining that no URL was provided.
- Worked around an unexplained bug observed in the wild causing Sandstorm to fail to load in a browser claiming "no such route", apparently when accessed from behind certain proxies.
- Worked around bug in libseccomp which could cause Sandstorm binaries built using older kernel headers to fail to filter newer syscalls, possibly making systems insecure. All of our releases have been built against up-to-date headers, so we don't believe our release builds have been affected.
- Fixed a case where "who has access" dialog could show users named "null".
- Self-hosting: STMP config has been broken out into components rather than using a "URL" format.
- Development: Restarting `spk dev` will now reload all grains of the app without the need to manually refresh.
- Internal refactoring of grain tab management.

### v0.150 (2016-03-13)
- **Sandstorm for Work:** For self-hosters in a business setting. Initial release supports LDAP and basic organization managament. Requires a feature key to enable. See the "For Work" section of the admin settings.
- Your set of open grains will now be preserved through refreshes and closing/reopening the browser.
- The "home" button is now aligned with the sidebar and collapses with it, which maybe makes it clearer that the rest of the top bar is attached to the content.
- The file-open dialogs when uploading an SPK or a grain backup now filter for the desired file type.
- Offer templates can now substitute a sluggified grain title into the template body.
- Browser's autocomplete will no longer draw over sharing autocomplete.

### v0.149 (2016-02-27) [bugfixes]
- Fix non-token-specific API host, i.e. all API tokens created before 0.146.

### v0.148 (2016-02-27) [bugfixes]
- Fix new offer template unauthenticated host properties feature to support mapping resource paths containing periods. This was failing because periods are not permitted in Mongo keys.

### v0.147 (2016-02-27)
- Offer templates can now define some static properties of the API host to be served statically in response to unauthenticated requests, such as the DAV header for OPTIONS requests as well as simple resources. This should allow DAV apps like Davros and Radicale to fix incompatibilities with certain client apps.
- Offer templates can now include a clipboard button which copies the text to the clipboard.
- Sharing emails to/from Github identities will now use the Github account's primary email address, rather than the first-listed address.
- Setting BIND_IP to an ipv6 address should now work.
- Improved styling of "shrink sidebar" button.
- Fixed that if you visited a grain URL when not logged in, saw the "request access" screen, then logged in as an identity that already has access, the "request access" screen would continue to display until refresh.
- Fixed that "request access" would display for non-existent grain IDs.
- Fixed several icons displaying incorrectly on IE, especially in the sharing UI.
- Fixed that the API endpoint URL in the (obscure) webkey dialog was showing up as `undefined`.

### v0.146 (2016-02-21)
- If you open a grain URL to which you do not have access -- presumably becaues the owner forgot to share it with you, and thought that just copy/pasting the URL would work -- you will now be presented with the ability to send an access request email.
- Client apps accessing Sandstorm grains via HTTP APIs no longer need to be whitelisted for use of HTTP Basic Auth. As part of this, Sandstorm now allocates a new random hostname for every API key. This change was made so that an upcoming CalDAV apps can be used with any standard CalDAV client. We still prefer new apps use bearer token authorization rather than basic auth.
- IP network capabilities can now be granted through the powerbox, opening the door to apps that need to operate at the raw TCP or UDP level -- however, only the server admin is able to grant such capabilities, since it could be a security problem for large shared servers.
- Shrinking the sidebar is now sticky (remembered by your browser, not by the server).
- It is now possible for developers to recover from losing their app signing key by submitting a pull request against `src/sandstorm/appid-replacements.capnp` in the Sandstorm repository.
- More large internal refactoring to switch to ES6 with JSCS-enforced style checking.
- Fixed another issue that could cause spurious errors when returning to grains after losing internet connectivity for a bit.
- Fixed problem that caused Groove Basin streams to disconnect.
- Oasis: Fixed another problem preventing adding an identity to your account which was already attached to some other empty account.
- Oasis: Fixed problem preventing signup keys from being consumed (applies to preorders and Indiegogo customers who hadn't claimed their invites yet).

### v0.145 (2016-02-16) [bugfixes]
- Updated glibc for CVE-2015-7547.
- Oasis: Fixed a bug that prevented adding an identity that is already attached to an empty account.

### v0.144 (2016-02-13)
- Initial version of Picker Powerbox implemented. A grain can now prompt the user to choose one of their other grains to share, and then the requesting grain can present that grain to other users. This could be used e.g. to share securely through a chat room or message board. Look for apps to start using this soon.
- When app search gives no results, we now suggest the user try the app market.
- HTTP headers `If-Match: *` and `If-None-Match: *` are now correctly passed through to the app.
- Added tooltips to all topbar items.
- The "share access" button now works in incognito mode (and suggests copy/pasting the link).
- Significant internal refactoring: Now using more ES6 features, and using `box-sizing: border-box` everywhere.
- Self-hosting: We now show an explanatory error message in the admin panel if `WILDCARD_HOST` is misconfigured, which we've found is a common mistake.
- Oasis: Fixed bug where grains could get stuck at "loading" spinner forever.

### v0.143 (2016-02-07) [bugfixes]
- Added support for HTTP PATCH method.
- Fixed inability to revoke some types of shares in the "who has access" dialog.
- Removed obsolete and confusing `sandstorm reset-oauth` shell command.

### v0.142 (2016-02-03) [bugfixes]
- Page titles (as in document.title) now use the server's title as specified in the admin settings rather than just "Sandstorm".
- Dev apps now appear first in the app list.
- Fixed apps with multiple "new" actions always using the last action when launched in dev mode.
- Fixed icon in sidebar for shared grains.
- Fixed computation of sharing stats (part of admin stats).
- Oasis: Fixed bug where free users were not getting infinite grains as promised after referring someone. :(
- Oasis: Users subscribed to our announcement mailing list will now receive 1GB bonus storage.

### v0.141 (2016-01-25) [bugfixes]
- Fix blank screen when trying to log in as an identity that is connected to one or more accounts as a non-login identity.
- Oasis: Fix regression that prevented linking an identity to your account which had already been logged into in the past but never created any grains. In this case, the old empty account is supposed to be deleted so that the identity can be added to the current account, however the recent referral program notification that was sent to everyone caused these accounts to be considered non-empty and thus not elligible for auto-deletion.

### v0.140 (2016-01-22)
- When you opeon a sharing invitation sent to you by user identity, and you are not currently logged in as that identity, you'll now get an informative message rather than "403 Unauthorized".
- Restoring a grain backup is now accomplished through a button on the grain list rather than the app list.
- The button to upload (aka sideload) an app spk has been moved to the side, since it tended to confuse people who didn't need it.
- When installing a new version of an app for which the appVersion hasn't changed, offer the option to upgrade existing grains. (Previously, the option was only provided if the appVersion was newer than existing grains. This primarily affects developers.)
- Accessibility improvements in sign-in menu.
- Consistently use the term "grain", not "file".
- Self-hosting: Give more helpful messaging when OAuth login configuration is auto-reset due to BASE_URL change.
- Self-hosting: Add ability to configure the server title and return address as used in, for example, login emails.
- Oasis: Notify everyone about the existence of the referral program.

### v0.139 (2016-01-11)
- Refactored authentication framework. No visible changes.
- Improved UX for logging in as a dev user.
- On installing first app, highlight the "create grain" UI and explain how it works.
- Up/down now work for selecting chips in sharing UI.
- Sidebar tabs now have tooltips with titles (for when sidebar is shrunk).
- Fix `setPath` postMessage API when passed an empty string.

### v0.138 (2015-12-18) [bugfixes]
- Fix bug in new sharing interface where if you typed an email address but did not press "enter" to turn it into a chip, then tried to send the invite, nothing was sent.
- Oasis: Referral program page is now designed.

### v0.137 (2015-12-15) [bugfixes]
- Tweak wording of app update notification.
- Bug fixes for servers running demo mode (probably only Oasis).

### v0.136 (2015-12-14)
- You can now share with other users "by identity" without ever creating a secret link (and thus you can avoid any chance of that link leaking). The sharing dialog implements an auto-complete interface for selecting such contacts. Only users who have previously revealed their identities to you will be shown. Note that e-mail invites to other users still generate secret URLs.
- When trying to link an additional identity to your account, if the identity already has an account, but that account is empty (no grains, no payment plan, etc.), Sandstorm will now automatically delete the other account so that the identity can be linked to yours. Previously, this situation reported an error saying that the identity couldn't be linked because it was already the login identity for another account. This was problematic because many users have logged in with various other "identities" in the past, causing those identities to have empty accounts attached.
- You can now set a custom splash page which people will see when they visit your server's home page while not logged in. Look under "advanced" in the admin settings.
- Icons for shared grains should now appear correctly in the sidebar (for new shares, at least).
- Oasis: Experimenting with showing payment plan selector on initial account creation. (You can still choose "free".)

### v0.135 (2015-12-08) [bugfixes]
- When visiting a share link anonymously, we now gently encourage the user to log in, since most apps work better when users are logged in.
- Fixed various problems that could cause blank gray screens (no error message) when visiting sharing links.
- Fixed double-counting of users in server stats, introduced in 0.133.
- Fixed recent regression in first-time setup flow which forced the admin to create two or even three admin tokens in order to complete setup. Only one should be required (which the install script auto-generates).

### v0.134 (2015-12-07) [bugfixes]
- Fix signup key consumption.
- Fix bug where sharing links didn't work after the owner unlinked the identity under which the grain was created.
- Sandcats: Fix bug that sometimes caused certificate rotation not to happen on time.
- Oasis: Implement referral program.

### v0.133 (2015-12-06)
- It is now possible to link multiple login identities to an account. For example, you can connect both your Google and your Github identity to the same account, so that you can log in with either. This was added for a few reasons, including:
    * To make it safer for us to expand the set of login providers, which might otherwise lead to confusion as people forget which provider they used to log in previously.
    * To allow sharing based on social identities rather than secret links. E.g. you may want to share a document with a particular Github user without knowing if they have a Sandstorm account.
    * To allow you to verify multiple email addresses, so that you can choose which one should receive Sandstorm service notifications independently of your login provider.
- Github login now receives your email address even if it isn't public on your Github account. This is necessary as Sandstorm needs a verified email address for notifications. You can control where notifications are sent by changing your primary address in the account settings.
- The sidebar can now be shrunk for more space, using a highly-visible slider button. This replaces the old functionality in which clicking the "sandstorm" button in the upper-left would toggle the sidebar entirely; few people realized that that was there, and those who did click the button expected it to go "home", which it now does.
- Demo mode now features a prominent timer in the sidebar. We found that people did not notice the timer in its previous upper-right location.
- `spk verify` now defaults to printing extended details, previously gated by the `--detail` flag.

### v0.132 (2015-11-11) [bugfixes]
- Fixed regression where app detail page showed "last updated" as "unknown" for all apps.
- Fixed SMTP escaping issue that was otherwise causing errors when sending from Roundcube through Mailgun.

### v0.131 (2015-11-10)
- App details are now displayed at install time, giving you a chance to review the app's signature and other metadata before completing installation.
- Apps can now directly request (via postMessage) that Sandstorm display the sharing dialog.
- Work around bug where web publishing could stop working on a particular grain saying that the capability had been closed. (Proper fix requires some refactoring, but at least now it will reconnect.)
- Started to transition icons to a font rather than lots of separate SVGs.

### v0.130 (2015-11-03) [bugfixes]
- Fix regression in v0.129 preventing the first user to log in from using Google or Github as the login service.

### v0.129 (2015-11-03)
- Changes to /etc/resolv.conf (DNS client configuration) will now be seen by Sandstorm without a restart. This should fix a number of outgoing name lookup problems seen on machines where the network configuration changes frequently, especilaly laptops that change Wifi networks often.
- Fix app icons not showing when using `spk dev`.
- Fix weird rendering of the "most-used" row of the app list immediately after updating an app that wasn't in the top row.
- Fixed regressions in app search.
- Attempt to fix "session was never opened" error.
- Fix regression where "first user becomes admin" could apply to dev accounts.

### v0.128 (2015-10-28) [bugfixes]
- Internal bugfixes.

### v0.127 (2015-10-26) [bugfixes]
- Fix bug in app details page causing pages to be blank in the presence of very old sharing tokens that lacked certain expected metadata.

### v0.126 (2015-10-26)
- Added app details page. Clicking on an app in the app grid now brings you to the details page rather than creating a new grain. From there, you can see your existing grains of that app and create new ones.
- Fixed problem where some apps would refresh to a 404 page when resuming a laptop from suspend.
- Sandstorm will now automatically repair its Mongo database after a dirty shutdown (e.g. power outage), rather than go into an infinite loop of Mongo failing to start.

### v0.125 (2015-10-21) [bugfixes]
- Fix bug causing Sandcats servers not to update their IP dynamically.

### v0.124 (2015-10-19) [bugfixes]
- Harden back-end code against possible front-end bugs that could inadvertently delete data. We do not believe any such bugs exist, but we like having extra layers of protection.

### v0.123 (2015-10-18) [bugfixes]
- Fixed regression introduced in v0.119 where `X-Sandstorm-User-Id` (as reported to apps) was computed incorrectly for email login users, causing apps to think the user was a different person than they were before the change. E.g. Etherpad would assign the user a different color from before. For some apps, this problem triggered app bugs of varying severity, such as Wekan making the board read-only and Laverna refusing to save changes. (Unfortunately, fixing this bug means that any grains created during the time when the bug was present will now show the same problems.)

### v0.122 (2015-10-16) [bugfixes]
- Fix formatting of app update notification.
- Add temporary debug logging aimed at diagnosing the rare event loop stalling bug which is apparently still not fixed.

### v0.121 (2015-10-15) [bugfixes]
- Fix regression where `spk dev` might fail to override normally-installed versions of the app. (Only affects development servers.)

### v0.120 (2015-10-15) [bugfixes]
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

### v0.118 (2015-10-07) [bugfixes]
- Fixed problem where Sandcats-HTTPS-enabled servers would request new certificates too often.
- This is a cherry-pick release -- no other changes merged in the last week are included.

### v0.117 (2015-09-30)
- Self-hosters using Sandcats now get automatic free HTTPS certificates. This is normally set up automatically during install. If you first installed before this release, [see the docs to find out how to enable HTTPS](https://docs.sandstorm.io/en/latest/administering/ssl/).

### v0.116 (2015-09-29)
- (Probably) fix very rare bug in which front-end stops talking to back-end causing grains to fail to load until the next front-end restart. The bug was in node-capnp's use of libuv. [EDIT: Did not fix problem. :(]
- Check PGP signatures on packages on install and store them in the database (not yet surfaced in UI).

### v0.115 (2015-09-24) [bugfixes]
- Attempt to work around very rare problem where front-end inexplicably stops talking to back-end by monitoring and recreating the connection.
- Oasis: Fix "download backup", which broke due to unexpected interaction between security hardening to the sandbox in which zip/unzip runs and security settings on Oasis.

### v0.114 (2015-09-23) [bugfixes]
- No-op release just to test end-to-end that the new signed update mechanism works. (We did lots of tests in advance, but touching the updater code always makes me nervous, so test again!)

### v0.113 (2015-09-23)
- The installer script is now PGP-signed such that it can be verified by third parties without relying on the integrity of HTTPS.
- The installer now verifies downloads using GPG (in addition to using HTTPS as it always has).
- Updates are now verified using libsodium ed25519 signatures (in addition to being downloaded over HTTPS as they always have).
- Oasis: Fixed storage bug that was causing random app restarts (but no data loss).
- Various small UI usability tweaks.

### v0.112 (2015-09-16) [bugfixes]
- Fix another stats bug causing stats recording to sometimes be interrupted by an exception.

### v0.111 (2015-09-16) [bugfixes]
- Fix bug preventing "who has access" table from displaying properly.

### v0.110 (2015-09-16) [bugfixes]
- Fix problem with display of app stats (in admin panel) in presence of broken package uploads.

### v0.109 (2015-09-15)
- You can now uninstall apps again.
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

### v0.107 (2015-08-31) [bugfixes]
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

### v0.104 (2015-08-03) [bugfixes]
- Fix sudden increase in log spam in 0.102 -- unnecessarily large full-HTML DNS TXT lookup error messages were being logged to the console; no more. In fact, now these are properly 404 errors as they should be.

### v0.103 (2015-08-03) [bugfixes]
- Emergency fix for bug that can cause startup failure in the presence of users that apparently have a `services` entry but no `profile`. The alpha server seems to have these but none of the test servers did.

### v0.102 (2015-08-03)
- New icons designed by Nena!
- New account settings page allows setting display name, profile picture, preferred handle, and preferred pronouns, all of which are passed on to apps. These are auto-populated from the login provider as much as possible.
- App packages may now include metadata like icons, license information, description, screenshots, and more, for use in the Sandstorm UI and upcoming app market. Large blobs embedded this way (e.g. images) will be extracted and served via a new static asset serving subsystem with high cacheability (also used for profile pictures).
- You may now configure Sandstorm to run on port 80. The socket is bound before dropping privileges and passed into the front-end via parent->child file descriptor inheritance.

### v0.101 (2015-07-25)
- Refactored CSS styling and accounts drop-down code. Please be on the lookout for bugs.
- Fixed bug where the admin settings page would simply say "Loading..." forever if the user was not authorized.

### v0.100 (2015-07-22) [bugfixes]
- Fix inability to configure Google/Github login accidentally introduced in v0.97 during security tightening.
- Add missing changelog for 0.99.

### v0.99 (2015-07-21) [bugfixes]
- Fix app scrolling on iOS.
- Fix popups being onclosable on iOS.
- Fix app selection on mobile.

### v0.98 (2015-07-19) [bugfixes]
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

### v0.95 (2015-07-11) [bugfixes]
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

### v0.91 (2015-06-20) [bugfixes]
- Bug: The first bug in v0.90 was not fully fixed: query parameters and fragments were still being dropped. This is blocking a thing, so we're pushing another fix. Sorry.

### v0.90 (2015-06-20) [bugfixes]
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

### v0.88 (2015-06-18) [bugfixes]
- Fix real-time activity stats not being displayed (in admin settings).
- Fix issue on Oasis where worker could get into a bad state and refuse to start grains.

### v0.87 (2015-06-13) [bugfixes]
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

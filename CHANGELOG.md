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

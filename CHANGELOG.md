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

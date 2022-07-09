How to push a Sandstorm release
===============================

You will need:
* The release signing key.
* SSH access to the Sandstorm release server.

Steps:

1. Make sure relevant pull requests have been merged.

2. `git pull` the master branch.

3. Update dependencies. After each step, commit the changes using the command you ran as the commit message.
    * Submodules: `make update-deps`
    * Meteor: `cd shell && meteor update --all-packages`
        * If Meteor can't be updated for some reason (e.g. a new release will break Sandstorm and
          we can't fix it yet), use `meteor update --packages-only --all-packages`
    * NPM modules: `cd shell && meteor npm update --depth 9999 --save`

4. Test it:
    * `make test` to run automated tests.
    * `make update` to update your local install, then manually test anything that seems worth sanity-checking, such as things that changed since last release.

5. Update `CHANGELOG.md` summarizing new changes.

6. Release it:
    * Run: `./release.sh`

7. Check alpha.sandstorm.io (which the release script will have directly updated) to verify it's not broken.

8. `git push`

Emergency Rollback
==================

If you discover after `release.sh` completes that the release is fatally broken, do this:

1. SSH into updates server and edit `/var/www/install.sandstorm.io/dev`. This file contains the current release number. Change it back to the previous release. This stops anyone else from updating.

2. Fix or revert the breakage and do a new release as soon as possible, so that the people who did update to the broken release can update again to fix it. Sandstorm does not allow rolling back a release once it has been installed, so a new release is the only way forward.


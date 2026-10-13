How to push a Sandstorm release
===============================

You will need:
* A Sandstorm.org release Yubikey.
* GitHub write access to the sandstorm and install-website repositories.
* Cloudflare R2 write access to dl.sandstorm.io.

The release signing key is also the automatic-update signing key. Its complete primary-key
fingerprint is stored in `keys/release-key-fingerprint`, and its public key must be present in
`keys/release-keyring.gpg` and in the installer's embedded key block and fingerprint check. Update
the fingerprint and verification instructions in `docs/install.md` at the same time.

Steps:

-1. Activate a venv with Python 3.10, i.e. `source ~/.venvs/sandstorm-build/bin/activate`

0. Run `gpg --card-status` to verify the build machine can access the release key.

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

5. Update `CHANGELOG.md` summarizing new changes. `git commit -m "Update changelog"`

6. Build it:
    * Run: `./release.sh`

   The script creates one detached OpenPGP `.sig` for the bundle and one each for `install.sh` and
   `migrate.sh`.

   For a key rotation that must bridge automatic updates, add both fingerprints temporarily to
   `SIGNING_KEY_IDS` in `release.sh`. The resulting `.sig` contains an independent signature from
   each key; old installations can validate the old signature while the bridge release installs the
   new trust root. Return the list to the new key only after the bridge. This is not needed for the
   build 308 to 309 transition because that upgrade is deliberately manual.

7. Update a test server to verify it's not broken.

8. `git push`

9. Upload the release tarball and it's .sig to the dl.sandstorm.org R2 bucket.

10. Commit install.sh, install.sh.sig, migrate.sh, and migrate.sh.sig to https://github.com/sandstorm-org/install-website

11. Set https://github.com/sandstorm-org/install-website/blob/main/dist/dev to the new build number.

Emergency Rollback
==================

If you discover after release that the release is fatally broken, do this:

1. Set https://github.com/sandstorm-org/install-website/blob/main/dist/dev back to the previous build number. This stops anyone else from updating.

2. Fix or revert the breakage and do a new release as soon as possible, so that the people who did update to the broken release can update again to fix it. Sandstorm does not allow rolling back a release once it has been installed, so a new release is the only way forward.

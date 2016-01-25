#! /bin/bash

set -euo pipefail

if (grep -r KJ_DBG src/* | egrep -v '/(debug(-test)?|exception)[.]'); then
  echo '*** Error:  There are instances of KJ_DBG in the code.' >&2
  exit 1
fi

if egrep -r 'TODO\(now\)' src/*; then
  echo '*** Error:  There are release-blocking TODOs in the code.' >&2
  exit 1
fi

make clean

if [ "x$(git status --porcelain)" != "x" ]; then
  echo "Please commit changes to git before releasing." >&2
  exit 1
fi

# TODO(soon): Once we have a way to start a beta branch, refuse to do so if there are TODO(soon)s.
# if (egrep -r 'TODO\(soon\)'); then
#   echo '*** Error:  There are release-blocking TODOs in the code.' >&2
#   exit 1
# fi

. branch.conf

if [ $(git rev-parse --abbrev-ref HEAD) = master ]; then
  CHANNEL=dev
elif [ $IS_STABLE = true ]; then
  CHANNEL=stable
else
  CHANNEL=beta
fi

echo "**** Determining next build number for $CHANNEL channel ****"

LAST_BUILD=$(curl -fs https://install.sandstorm.io/$CHANNEL)

if (( LAST_BUILD / 1000 > BRANCH_NUMBER )); then
  echo "ERROR: $CHANNEL has already moved past this branch!" >&2
  echo "  I refuse to replace it with an older branch." >&2
  exit 1
fi

BASE_BUILD=$(( BRANCH_NUMBER * 1000 ))
BUILD=$(( BASE_BUILD > LAST_BUILD ? BASE_BUILD : LAST_BUILD + 1 ))
BUILD_MINOR="$(( $BUILD % 1000 ))"
DISPLAY_VERSION="${BRANCH_NUMBER}.${BUILD_MINOR}"
TAG_NAME="v${DISPLAY_VERSION}"
SIGNING_KEY_ID=160D2D577518B58D94C9800B63F227499DA8CCBD

# Verify that the changelog has been updated.
EXPECTED_CHANGELOG="### $TAG_NAME ($(date '+%Y-%m-%d'))"
if [[ "$(head -n 1 CHANGELOG.md)" != "$EXPECTED_CHANGELOG"* ]]; then
  echo "Changelog not updated. First line should be:" >&2
  echo "$EXPECTED_CHANGELOG" >&2
  exit 1
fi

# The tarball stores the version number as an integer, e.g. 75 for
# build 75 within branch 0, or 2121 for build 121 within branch 2, so
# that the Sandstorm auto-updater can avoid having complicated
# version-comparison logic.
TARBALL=sandstorm-$BUILD.tar.xz

echo "**** Building build $BUILD ****"

make BUILD=$BUILD

echo "**** Tagging this commit ****"

# The git tag stores the version number as a normal-looking version
# number, like 0.75 for build 75 within branch 0, or 2.121 for build
# 121 within branch 2.

GIT_REVISION="$(<bundle/git-revision)"
git tag -u $SIGNING_KEY_ID "$TAG_NAME" "$GIT_REVISION" -m "Release Sandstorm ${DISPLAY_VERSION}"
git push origin "$TAG_NAME"

echo "**** Pushing build $BUILD ****"

rm -f $TARBALL.sig $TARBALL.update-sig install.sh.sig

# Sign the tarball and the install script. Note that we don't sign the channel build number because
# it wouldn't accomplish anything: If an attacker wanted to provide an old number, they could
# provide the old signature to match. If an attacker provided a number that hasn't been used
# before, they would not be able to provide a matching package because no such signed package
# exists.
gpg -u $SIGNING_KEY_ID --digest-algo SHA512 --detach-sig $TARBALL
gpg -u $SIGNING_KEY_ID --digest-algo SHA512 --detach-sig install.sh

# Create signature used to verify updates.
tmp/sandstorm/update-tool sign ~/.sandstorm-update-keyring $TARBALL > $TARBALL.update-sig

echo $BUILD > tmp/$CHANNEL
gce-ss copy-files $TARBALL fe:/var/www/dl.sandstorm.io
gce-ss copy-files $TARBALL.sig fe:/var/www/dl.sandstorm.io
gce-ss copy-files $TARBALL.update-sig fe:/var/www/dl.sandstorm.io
gce-ss copy-files tmp/$CHANNEL fe:/var/www/install.sandstorm.io
gce-ss copy-files install.sh fe:/var/www/install.sandstorm.io
gce-ss copy-files install.sh.sig fe:/var/www/install.sandstorm.io

gce-ss ssh alpha --command 'sudo service sandstorm update dev'

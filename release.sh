#! /bin/bash

set -euo pipefail

if (grep -r KJ_DBG src | egrep -v '/debug(-test)?[.]'); then
  echo '*** Error:  There are instances of KJ_DBG in the code.' >&2
  exit 1
fi

if (egrep -r 'TODO\(now\)'); then
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

# The tarball stores the version number as an integer, e.g. 75 for
# build 75 within branch 0, or 2121 for build 121 within branch 2, so
# that the Sandstorm auto-updater can avoid having complicated
# version-comparison logic.
TARBALL=sandstorm-$BUILD.tar.xz

echo "**** Building build $BUILD ****"

make BUILD=$BUILD

echo "**** Pushing build $BUILD ****"

echo $BUILD > tmp/$CHANNEL
gcutil push fe $TARBALL /var/www/dl.sandstorm.io
gcutil push fe tmp/$CHANNEL /var/www/install.sandstorm.io

gcutil ssh smalldemo sudo service sandstorm update
gcutil ssh alpha sudo service sandstorm update dev

echo "**** Tagging this commit ****"

# The git tag stores the version number as a normal-looking version
# number, like 0.75 for build 75 within branch 0, or 2.121 for build
# 121 within branch 2.

BUILD_MINOR="$(( $BUILD % 1000 ))"
DISPLAY_VERSION="${BRANCH_NUMBER}.${BUILD_MINOR}"
TAG_NAME="sandstorm-${DISPLAY_VERSION}"
GIT_REVISION="$(<bundle/git-revision)"
git tag "$TAG_NAME" "$GIT_REVISION" -m "Release Sandstorm ${DISPLAY_VERSION}"
git push origin "$TAG_NAME"

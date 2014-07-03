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

TARBALL=sandstorm-$BUILD.tar.xz

echo "**** Building build $BUILD ****"

make -j BUILD=$BUILD XZ_FLAGS=-9e

echo "**** Pushing build $BUILD ****"

echo $BUILD > tmp/$CHANNEL
gcutil push fe $TARBALL /var/www/dl.sandstorm.io
gcutil push fe tmp/$CHANNEL /var/www/install.sandstorm.io

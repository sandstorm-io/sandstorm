#! /bin/bash

set -euo pipefail

make clean

if [ "x$(git status --porcelain)" != "x" ]; then
  echo "Please commit changes to git before releasing." >&2
  exit 1
fi

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

if curl -fIs "https://dl.sandstorm.io/$TARBALL" > /dev/null; then
  echo "ERROR: It appears this build already exists on the server." >&2
  exit 1
fi

echo "**** Building build $BUILD ****"

make -j bundle-dist BUILD=$BUILD

echo "**** Pushing build $BUILD ****"

echo $BUILD > tmp/$CHANNEL
gcutil push fe $TARBALL /var/www/dl.sandstorm.io
gcutil push fe tmp/$CHANNEL /var/www/install.sandstorm.io

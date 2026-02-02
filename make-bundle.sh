#! /bin/bash
#
# Sandstorm - Personal Cloud Sandbox
# Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
# All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

set -euo pipefail
shopt -s extglob

rm -rf bundle

fail() {
  echo "make-bundle.sh: FAILED at line $1" >&2
  rm -rf bundle
  exit 1
}

trap 'fail ${LINENO}' ERR

copyDep() {
  # Copies a file from the system into the chroot.

  local FILE=$1
  local DST=bundle"${FILE/#\/usr\/local/\/usr}"

  if [ -e "$DST" ]; then
    # already copied
    :
  elif [[ "$FILE" == /etc/* ]]; then
    # We'll want to copy configuration (e.g. for DNS) from the host at runtime.
    if [ -f "$FILE" ]; then
      echo "$FILE" >> tmp/host.list
    fi
  elif [ -h "$FILE" ]; then
    # Symbolic link.
    # We copy over the target, and recreate the link.
    # Currently we denormalize the link because I'm not sure how to follow
    # one link at a time in bash (since readlink without -f gives a relative
    # path and I'm not sure how to interpret that against the link's path).
    # I'm sure there's a way, but whatever...
    mkdir -p $(dirname "$DST")
    local LINK=$(readlink -f "$FILE")
    ln -sf "${LINK/#\/usr\/local/\/usr}" "$DST"
    copyDep "$LINK"
  elif [ -d "$FILE" ]; then
    # Directory.  Make it, but don't copy contents; we'll do that later.
    mkdir -p "$DST"
  elif [ -f "$FILE" ]; then
    # Regular file.  Copy it over.
    mkdir -p $(dirname "$DST")
    cp "$FILE" "$DST"
  fi
}

copyDeps() {
  # Reads filenames on stdin and copies them into the chroot.

  while read FILE; do
    copyDep "$FILE"
  done
}

# Check for requiremnets.
for CMD in zip unzip xz gpg; do
  if ! which "$CMD" > /dev/null; then
    echo "Please install $CMD" >&2
    fail ${LINENO}
  fi
done

METEOR_DEV_BUNDLE=$(./find-meteor-dev-bundle.sh)

# Start with the meteor bundle.
cp -r shell-build/bundle bundle
rm -f bundle/README
cp meteor-bundle-main.js bundle/sandstorm-main.js

# Meteor wants us to do `npm install` in the bundle to prepare it.
# The fibers package builds native extensions, choosing the target v8 version based on
# the version of `/usr/bin/env node`. We need to make it does not pick up the wrong binary,
# so we place Meteor's node first on `PATH`.  Additional native extensions require node-pre-gyp,
# which lives in the .bin folder of the dev bundle's node_modules.
(cd bundle/programs/server && \
 PATH=$METEOR_DEV_BUNDLE/lib/node_modules/.bin:$METEOR_DEV_BUNDLE/bin:$PATH "$METEOR_DEV_BUNDLE/bin/npm" install)

# Copy over key binaries.
mkdir -p bundle/bin
cp bin/sandstorm-http-bridge bundle/bin/sandstorm-http-bridge
cp bin/sandstorm bundle/sandstorm
cp $METEOR_DEV_BUNDLE/bin/node bundle/bin

# We used to pull mongodb out of the meteor dev bundle, but we need to figure out how to safely
# upgrade some databases created with very old mongo versions, so we're shipping mongo 2.6 for
# now.
#cp $METEOR_DEV_BUNDLE/mongodb/bin/{mongo,mongod} bundle/bin

# Pull mongo v2.6 out of a previous Sandstorm package.
OLD_BUNDLE_BASE=sandstorm-171
OLD_BUNDLE_FILENAME=$OLD_BUNDLE_BASE.tar.xz
OLD_BUNDLE_PATH="hack/$OLD_BUNDLE_FILENAME"
OLD_BUNDLE_SHA256=ebffd643dffeba349f139bee34e4ce33fd9b1298fafc1d6a31eb35a191059a99
OLD_MONGO_FILES="$OLD_BUNDLE_BASE/bin/mongo $OLD_BUNDLE_BASE/bin/mongod"
if [ ! -e "$OLD_BUNDLE_PATH" ] ; then
  echo "Fetching $OLD_BUNDLE_FILENAME to extract a mongo 2.6..."
  curl --output "$OLD_BUNDLE_PATH" https://dl.sandstorm.io/$OLD_BUNDLE_FILENAME
fi

# Always check the checksum to guard against corrupted downloads.
sha256sum --check <<EOF
$OLD_BUNDLE_SHA256  $OLD_BUNDLE_PATH
EOF
# set -e should ensure we don't continue past here, but let's be doubly sure
rc=$?
if [ $rc -ne 0 ]; then
  echo "Old bundle did not match expected checksum.  Aborting."
  exit 1
fi

# Extract bin/mongo and bin/mongod from the old sandstorm bundle, and place them in bundle/.
tar xf $OLD_BUNDLE_PATH --transform=s/^${OLD_BUNDLE_BASE}/bundle/ $OLD_MONGO_FILES

# Download MongoDB 2.6.12 to get mongodump (not included in the old Sandstorm bundle).
MONGO26_VERSION=2.6.12
MONGO26_FILENAME=mongodb-linux-x86_64-${MONGO26_VERSION}.tgz
MONGO26_PATH="hack/$MONGO26_FILENAME"
MONGO26_SHA256=6d6415ac068825d1aed23f9482080ce3551bfac828d9570be1d72990d5f441b0
if [ ! -e "$MONGO26_PATH" ] ; then
  echo "Fetching MongoDB 2.6.12 for mongodump..."
  curl --output "$MONGO26_PATH" "https://fastdl.mongodb.org/linux/$MONGO26_FILENAME"
fi

sha256sum --check <<EOF
$MONGO26_SHA256  $MONGO26_PATH
EOF
rc=$?
if [ $rc -ne 0 ]; then
  echo "MongoDB 2.6.12 package did not match expected checksum.  Aborting."
  exit 1
fi

# Extract mongodump from MongoDB 2.6.12.
MONGO26_BASE=mongodb-linux-x86_64-${MONGO26_VERSION}
tar xf $MONGO26_PATH ${MONGO26_BASE}/bin/mongodump
cp ${MONGO26_BASE}/bin/mongodump bundle/bin/mongodump
rm -rf ${MONGO26_BASE}

# Download MongoDB 7.0 for migration support.
# Both versions are bundled - users run 'sandstorm migrate-mongo'
# to upgrade their database from 2.6 to 7.0.
MONGO7_VERSION=7.0.16
MONGO7_FILENAME=mongodb-linux-x86_64-ubuntu2004-${MONGO7_VERSION}.tgz
MONGO7_PATH="hack/$MONGO7_FILENAME"
MONGO7_SHA256=PLACEHOLDER_NEEDS_UPDATE
if [ ! -e "$MONGO7_PATH" ] ; then
  echo "Fetching MongoDB 7.0..."
  curl --output "$MONGO7_PATH" "https://fastdl.mongodb.org/linux/$MONGO7_FILENAME"
fi

# Calculate checksum if placeholder (for development)
if [ "$MONGO7_SHA256" = "PLACEHOLDER_NEEDS_UPDATE" ]; then
  echo "WARNING: Using downloaded file without checksum verification"
  MONGO7_SHA256=$(sha256sum "$MONGO7_PATH" | cut -d' ' -f1)
  echo "Downloaded file SHA256: $MONGO7_SHA256"
fi

sha256sum --check <<EOF
$MONGO7_SHA256  $MONGO7_PATH
EOF
rc=$?
if [ $rc -ne 0 ]; then
  echo "MongoDB 7.0 package did not match expected checksum.  Aborting."
  exit 1
fi

# Extract mongod from MongoDB 7.0 package.
# Note: MongoDB 7.0 doesn't include the legacy mongo shell, use mongosh instead.
MONGO7_BASE=mongodb-linux-x86_64-ubuntu2004-${MONGO7_VERSION}
mkdir -p bundle/bin
tar xf $MONGO7_PATH ${MONGO7_BASE}/bin/mongod
cp ${MONGO7_BASE}/bin/mongod bundle/bin/mongod7
rm -rf ${MONGO7_BASE}

# Download MongoDB Database Tools (mongodump, mongorestore) for MongoDB 7.0.
# These are distributed separately since MongoDB 4.4+.
MONGO_TOOLS_VERSION=100.10.0
MONGO_TOOLS_FILENAME=mongodb-database-tools-ubuntu2004-x86_64-${MONGO_TOOLS_VERSION}.tgz
MONGO_TOOLS_PATH="hack/$MONGO_TOOLS_FILENAME"
MONGO_TOOLS_SHA256=74583f31eb2fefa4b7016b525b0f50209a4e20364f41719cc8c93b7156e49937
if [ ! -e "$MONGO_TOOLS_PATH" ] ; then
  echo "Fetching MongoDB Database Tools..."
  curl --output "$MONGO_TOOLS_PATH" "https://fastdl.mongodb.org/tools/db/$MONGO_TOOLS_FILENAME"
fi

sha256sum --check <<EOF
$MONGO_TOOLS_SHA256  $MONGO_TOOLS_PATH
EOF
rc=$?
if [ $rc -ne 0 ]; then
  echo "MongoDB Database Tools package did not match expected checksum.  Aborting."
  exit 1
fi

# Extract mongorestore from database tools package.
MONGO_TOOLS_BASE=mongodb-database-tools-ubuntu2004-x86_64-${MONGO_TOOLS_VERSION}
tar xf $MONGO_TOOLS_PATH ${MONGO_TOOLS_BASE}/bin/mongorestore
cp ${MONGO_TOOLS_BASE}/bin/mongorestore bundle/bin/mongorestore7
rm -rf ${MONGO_TOOLS_BASE}

# Download mongosh (MongoDB Shell) for MongoDB 7.0.
# MongoDB 7.0+ uses mongosh instead of the legacy mongo shell.
MONGOSH_VERSION=2.3.8
MONGOSH_FILENAME=mongosh-${MONGOSH_VERSION}-linux-x64.tgz
MONGOSH_PATH="hack/$MONGOSH_FILENAME"
MONGOSH_SHA256=23edb768189663aaa9732a2340a25b5fc05a314940538809a7840be7f2ce221f
if [ ! -e "$MONGOSH_PATH" ] ; then
  echo "Fetching mongosh..."
  curl --output "$MONGOSH_PATH" "https://downloads.mongodb.com/compass/$MONGOSH_FILENAME"
fi

sha256sum --check <<EOF
$MONGOSH_SHA256  $MONGOSH_PATH
EOF
rc=$?
if [ $rc -ne 0 ]; then
  echo "mongosh package did not match expected checksum.  Aborting."
  exit 1
fi

# Extract mongosh binary.
MONGOSH_BASE=mongosh-${MONGOSH_VERSION}-linux-x64
tar xf $MONGOSH_PATH ${MONGOSH_BASE}/bin/mongosh
cp ${MONGOSH_BASE}/bin/mongosh bundle/bin/mongosh
rm -rf ${MONGOSH_BASE}

cp $(which zip unzip xz gpg) bundle/bin

# 'node-fibers' depends on a package (detect-libc) that uses various heuristics
# to work out what libc implementation & version it was linked against. The more
# reliable ones use these commands, so we include them to increase the chances
# of success. Notably, without these detecting the correct libc fails if the
# bundle was built on current Archlinux (as of Jan. 2020).
cp $(which ldd getconf) bundle/bin

# Older installs might be symlinking /usr/local/bin/spk to
# /opt/sandstorm/latest/bin/spk, while newer installs link it to
# /opt/sandstorm/sandstorm. We should keep creating the old symlink to avoid
# breakages.
ln -s ../sandstorm bundle/bin/spk

# Binaries copied from Meteor aren't writable by default.
chmod u+w bundle/bin/*

# Copy over capnp schemas.
mkdir -p bundle/usr/include/{capnp,sandstorm}
cp src/capnp/!(*test*).capnp bundle/usr/include/capnp
cp src/sandstorm/!(*-internal).capnp bundle/usr/include/sandstorm

# Copy over node_modules.
cp -r node_modules bundle

# Copy over all necessary shared libraries.
(ldd bundle/bin/* $(find bundle -name '*.node') || true) | grep -o '[[:space:]]/[^ ]*' | copyDeps

# Determine dependencies needed to run getaddrinfo() and copy them over.  glibc loads the
# DNS library dynamically, so `ldd` alone won't tell us this.  Also we want to find out
# what config files are needed from /etc, though we don't copy them over until runtime.
cat > tmp/dnstest.c << '__EOF__'
#include <sys/types.h>
#include <sys/socket.h>
#include <netdb.h>
#include <stdlib.h>

int main() {
  struct addrinfo* result;
  getaddrinfo("example.com", "http", NULL, &result);
  return 0;
}
__EOF__

$CC tmp/dnstest.c -o tmp/dnstest
strace tmp/dnstest 2>&1 | grep -o '"/[^"]*"' | tr -d '"' | copyDeps

# Add some whitelisted entries to host.list that we always want to include,
# even if the build machine doesn't necessarily use them.  This helps handle
# systems that use resolvconf to manage /etc/resolv.conf.
# We skip copyDeps because it only adds files that exist on this system; we
# wish to make things work for systems configured differently from the build host.
cat >> tmp/host.list << '__EOF__'
/etc/gai.conf
/etc/host.conf
/etc/hosts
/etc/nsswitch.conf
/etc/resolvconf
/etc/resolv.conf
/etc/services
/run/resolvconf
/run/systemd/resolve/resolv.conf
__EOF__

# Dedup the host.list and copy over.  Don't copy the ld.so.x files, though.
cat tmp/host.list | grep -v '/ld[.]so[.]' | sort | uniq > bundle/host.list

# Make mount points.
mkdir -p bundle/{dev,proc,tmp,etc,etc.host,run,run.host,var}
touch bundle/dev/{null,zero,random,urandom,fuse}

# Generate a suitable C.UTF-8 locale that we and Mongo can rely on
mkdir -p bundle/usr/lib/locale
localedef --no-archive --inputfile=./localedata-C --charmap=UTF-8 bundle/usr/lib/locale/C.UTF-8

# Don't strip binaries.  Having symbols is very useful for debugging and profiling.  Debug symbols
# usually compress well, add basically no runtime perf impact when not being used by other tools,
# and the debug sections probably won't even get mapped until used let alone faulted in.

if [ -e .git ]; then
  git rev-parse HEAD > bundle/git-revision
else
  echo "unknown" > bundle/git-revision
fi
echo "$USER@$HOSTNAME $(date)" > bundle/buildstamp

cat > bundle/README.md << '__EOF__'
# Sandstorm Bundle

See: http://sandstorm.io

This is a self-contained, batteries-included Sandstorm server. It should
work on any Linux kernel whose version is 3.13 or newer. The rest of your
filesystem is not touched and may as well be empty; everything will run in
a chroot.

This bundle is intended to be installed using the Sandstorm installer or
updater. To install Sandstorm, please run:

    curl https://install.sandstorm.io | bash

If you have already installed Sandstorm, you can update your installation to
this version by running:

    service sandstorm update <filename>.tar.xz
__EOF__

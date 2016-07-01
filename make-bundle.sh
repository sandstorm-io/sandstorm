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
# so we prepend `METEOR_DEV_BUNDLE/bin` to `PATH`.
(cd bundle/programs/server && \
 PATH=$METEOR_DEV_BUNDLE/bin:$PATH "$METEOR_DEV_BUNDLE/bin/npm" install)

# Copy over key binaries.
mkdir -p bundle/bin
cp bin/sandstorm-http-bridge bundle/bin/sandstorm-http-bridge
cp bin/sandstorm bundle/sandstorm
cp $METEOR_DEV_BUNDLE/bin/node bundle/bin
cp $METEOR_DEV_BUNDLE/mongodb/bin/{mongo,mongod} bundle/bin
cp $(which zip unzip xz gpg) bundle/bin

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
cp src/sandstorm/*.capnp bundle/usr/include/sandstorm

# Copy over node_modules.
mkdir -p bundle/node_modules
cp -r node_modules/!(sandstorm) bundle/node_modules

# Shove tcmalloc into the bundle if it's available, so that we can use it for heap profiling on
# Oasis.
# TODO(soon): Remove this once we've solved the memory leak.
TCMALLOC=
if [ -e /usr/lib/libtcmalloc.so.4 ]; then
  copyDep /usr/lib/libtcmalloc.so.4
  TCMALLOC=/usr/lib/libtcmalloc.so.4
fi

# Copy over all necessary shared libraries.
(ldd bundle/bin/* $TCMALLOC $(find bundle -name '*.node') || true) | grep -o '[[:space:]]/[^ ]*' | copyDeps

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

gcc tmp/dnstest.c -o tmp/dnstest
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

# Make bundle smaller by stripping stuff.
strip bundle/sandstorm bundle/bin/*
find bundle -name '*.so' | xargs strip

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

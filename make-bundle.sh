#! /bin/bash

set -euo pipefail

rm -rf bundle

copyDep() {
  # Copies a file from the system into the chroot.
  
  local FILE=$1
  local DST=bundle"$FILE"
  
  if [ -e "$DST" ]; then
    # already copied
    :
  elif [[ "$FILE" == /etc/* ]]; then
    # We'll want to copy configuration (e.g. for DNS) from the host at runtime.
    if [ -f "$FILE" ]; then
      mkdir -p $(dirname "$DST")
      echo "$FILE" >> tmp/etc.list
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
    ln -sf "$LINK" "$DST"
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

METEOR=$HOME/.meteor
METEOR_RELEASE=$(<shell/.meteor/release)
METEOR_TOOLS=$METEOR/tools/$(json tools < $METEOR/releases/$METEOR_RELEASE.release.json)

# Unpack meteor bundle of shell.
tar zxf shell-bundle.tar.gz
rm bundle/README

# Copy over key binaries.
mkdir -p bundle/bin
cp bin/spk bundle/bin/spk
cp bin/sandstorm-supervisor bundle/bin/sandstorm-supervisor
cp bin/run-bundle bundle/sandstorm
cp $METEOR_TOOLS/bin/node bundle/bin
cp $METEOR_TOOLS/mongodb/bin/{mongo,mongod} bundle/bin
cp /bin/busybox bundle/bin
cp /usr/bin/xz bundle/bin

# Copy over capnp schemas.
mkdir -p bundle/usr/include/{capnp,sandstorm}
test -e /usr/include/capnp/c++.capnp && cp /usr/include/capnp/*.capnp bundle/usr/include/capnp
test -e /usr/local/include/capnp/c++.capnp && cp /usr/local/include/capnp/*.capnp bundle/usr/include/capnp
cp src/sandstorm/*.capnp bundle/usr/include/sandstorm

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

gcc tmp/dnstest.c -o tmp/dnstest
strace tmp/dnstest 2>&1 | grep -o '"/[^"]*"' | tr -d '"' | copyDeps

# Dedup the etc.list and copy over.  Don't copy the ld.so.x files, though.
cat tmp/etc.list | grep -v '/ld[.]so[.]' | sort | uniq > bundle/etc.list

# Mongo wants these localization files.
mkdir -p bundle/usr/lib
cp -r /usr/lib/locale bundle/usr/lib
mkdir -p bundle/usr/share/locale
cp /usr/share/locale/locale.alias bundle/usr/share/locale

# Set up busybox symlink farm.
for command in \
    [ [[ acpid adjtimex ar arp arping ash awk basename blockdev brctl bunzip2 bzcat bzip2 cal cat chgrp chmod chown \
    chroot chvt clear cmp cp cpio cttyhack cut date dc dd deallocvt depmod devmem df diff dirname dmesg dnsdomainname \
    dos2unix du dumpkmap dumpleases echo egrep env expand expr false fgrep find fold free freeramdisk fstrim ftpget \
    ftpput getopt getty grep groups gunzip gzip halt head hexdump hostid hostname httpd hwclock id ifconfig init insmod \
    ionice ip ipcalc kill killall klogd last less ln loadfont loadkmap logger login logname logread losetup ls lsmod \
    lzcat lzma md5sum mdev microcom mkdir mkfifo mknod mkswap mktemp modinfo modprobe more mount mt mv nameif nc netstat \
    nslookup od openvt patch pidof ping ping6 pivot_root poweroff printf ps pwd rdate readlink realpath reboot renice \
    reset rev rm rmdir rmmod route rpm rpm2cpio run-parts sed seq setkeycodes setsid sh sha1sum sha256sum sha512sum sleep \
    sort start-stop-daemon stat strings stty swapoff swapon switch_root sync sysctl syslogd tac tail tar taskset tee \
    telnet test tftp time timeout top touch tr traceroute traceroute6 true tty udhcpc udhcpd umount uname uncompress \
    unexpand uniq unix2dos unlzma unxz unzip uptime usleep uudecode uuencode vconfig vi watch watchdog wc wget which who \
    whoami xargs xzcat yes zcat; do
  ln -s busybox bundle/bin/$command
done

# Set up /var
mkdir -p bundle/var/{log,pid,mongo} bundle/var/sandstorm/{apps,grains,downloads}

# Create mount points
mkdir -p bundle/{dev,proc,tmp}

# Create run script.
cat > bundle/setup.sh << '__EOF__'
#! /bin/bash

set -euo pipefail

# Make sure we're in the bundle directory.
cd $(dirname $(which $0))

prompt() {
  local VALUE
  read -p "$1: [$2] " VALUE
  if [ x"$VALUE" == x ]; then
    VALUE=$2
  fi
  echo "$VALUE"
}

writeConfig() {
  while [ $# -gt 0 ]; do
    eval echo "$1=\$$1"
    shift
  done
}

if [ -e sandstorm.conf ]; then
  . sandstorm.conf
else
  echo "No config file found.  Let's make one!"
  
  if [ "$USER" == root ]; then
    DEFAULT_USER=sandstorm
  else
    DEFAULT_USER=$USER
  fi

  SERVER_USER=$(prompt "Local user account to run server under" "$DEFAULT_USER")
  
  while [ "x$SERVER_USER" = xroot ]; do
    echo "Sandstorm cannot run as root!" >&2
    SERVER_USER=$(prompt "Local user account to run server under" "$DEFAULT_USER")
  done

  if ! id "$SERVER_USER" > /dev/null 2>&1; then
    CREATE_USER=$(prompt "User account '$SERVER_USER' doesn't exist. Create it?" yes)
    if [[ "x$CREATE_USER" != x[nN]* ]]; then
      adduser --system --group "$SERVER_USER"
    fi
  fi
  
  PORT=$(prompt "Server main HTTP port" "3000")
  
  while [ "$PORT" -lt 1024 ]; do
    echo "Ports below 1024 require root privileges. Sandstorm does not run as root." >&2
    echo "To use port $PORT, you'll need to set up a reverse proxy like nginx that " >&2
    echo "forwards to the internal higher-numbered port. The Sandstorm git repo " >&2
    echo "contains an example nginx config for this." >&2
    PORT=$(prompt "Server main HTTP port" "3000")
  done
  
  MONGO_PORT=$(prompt "MongoDB port" "$((PORT + 1))")
  LOCAL_ONLY=$(prompt "Expose to localhost only?" "yes")
  if [[ "x$LOCAL_ONLY" == x[nN]* ]]; then
    BIND_IP=0.0.0.0
    SS_HOSTNAME=$(hostname)
  else
    BIND_IP=127.0.0.1
    SS_HOSTNAME=localhost
  fi
  BASE_URL=$(prompt "URL users will enter in browser" "http://$SS_HOSTNAME:$PORT")

  echo
  echo "If you want to be able to send e-mail invites and password reset messages, "
  echo "enter a mail server URL of the form 'smtp://user:pass@host:port'.  Leave "
  echo "blank if you don't care about these features."
  MAIL_URL=$(prompt "Mail URL" "")
  
  writeConfig SERVER_USER PORT MONGO_PORT BIND_IP BASE_URL MAIL_URL > sandstorm.conf
  
  echo
  echo "Config written to sandstorm.conf."
fi

if [ $(whoami) != root ]; then
  echo "Please re-run this script as root to continue." >&2
  exit 1
fi

GROUP=$(id -g $SERVER_USER)

chown -R root:$GROUP .
chmod -R g-w,o= .
chmod a=rwx tmp

# Server can write to these directories.
chmod g+w var/{log,mongo,pid} var/sandstorm/{apps,grains,downloads}

# TODO(security):  If the grain IDs couldn't be trivially enumerated via Mongo
#   anyway, we'd want to make the grains directory non-readable.

echo "Setup complete.  Now try:"
echo "    sudo ./sandstorm start         # start the server"
echo "    sudo ./install-init-script.sh  # make it start at boot"
__EOF__
chmod +x bundle/setup.sh

cat > bundle/install-init-script.sh << '__EOF__'
#! /bin/bash

set -euo pipefail

SANDSTORM_DIR=$(dirname $(readlink -f $(which $0)))

cat > /etc/init.d/sandstorm << __EOF2__
#! /bin/sh
### BEGIN INIT INFO
# Provides:          sandstorm
# Required-Start:    \$local_fs \$remote_fs \$networking \$syslog
# Required-Stop:     \$local_fs \$remote_fs \$networking \$syslog
# Default-Start:     2 3 4 5
# Default-Stop:      0 1 6
# Short-Description: starts Sandstorm personal cloud server
### END INIT INFO

DESC="Sandstorm server"
DAEMON=$SANDSTORM_DIR/sandstorm

if [ "\$#" = 0 ]; then
  \$DAEMON help
else
  \$DAEMON "\$@"
fi
__EOF2__
chmod +x /etc/init.d/sandstorm

update-rc.d sandstorm defaults

echo "Sandstorm initscript installed. Start the server now with:"
echo "  service sandstorm start"
__EOF__
chmod +x bundle/install-init-script.sh

cat > bundle/README.md << '__EOF__'
# Sandstorm Bundle

This is a self-contained, batteries-included Sandstorm server.  This should
work on any recent Linux kernel (tested on 3.10, but some earlier versions
might work too).  The rest of your filesystem is not touched and may as well
be empty; everything will run in a chroot.

Configuration
=============

First, you need to create a config.  Run:

    sudo ./setup.sh

This prompts you for some configuration, writes `sandstorm.conf`, and then sets
appropriate properties on everything in the directory (e.g. making most things
owned by root).  To use the defaults (recommended), just repeatedly press
enter.

(Note:  If `sandstorm.conf` already exists, `setup.sh` will not prompt.  If you
just want to create a `sandstorm.conf` to use on a different machine, run
`setup.sh` as non-root; it will then stop after writing the config.)

Starting the Server
===================

Once setup is done, you can start the server as follows:

    sudo ./sandstorm start

You can also use the "sandstorm" tool to kill the server, run a mongo client,
and other things.  Run "sandstorm help" for info.

NOTE:  The first user to log into your server will be given admin rights.  Make
sure this is you!  :)

Running at System Boot
======================

To set up Sandstorm to run at boot, run:

    sudo ./install-init-script.sh

This places a SysV-style init script in /etc/init.d and enables it to run at
startup.  After this, you can use the `service` command as an alternative to
the `sandstorm` binary, e.g.:

    sudo service sandstorm start

The init script is just a thin wrapper around the `sandstorm` command; they
control the same server state.
__EOF__


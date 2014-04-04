#! /bin/bash

set -euo pipefail

rm -rf bundle

METEOR=$HOME/.meteor
METEOR_RELEASE=$(<shell/.meteor/release)
METEOR_TOOLS=$METEOR/tools/$(json tools < $METEOR/releases/$METEOR_RELEASE.release.json)

# Unpack meteor bundle of shell.
tar zxf shell-bundle.tar.gz

# Copy over key binaries.
mkdir -p bundle/bin
cp bin/{sandstorm-supervisor,spk} bundle/bin
cp bin/run-bundle bundle/run
cp $METEOR_TOOLS/bin/node bundle/bin
cp $METEOR_TOOLS/mongodb/bin/{mongo,mongod} bundle/bin
cp /bin/busybox bundle/bin

# Copy over capnp schemas.
mkdir -p bundle/usr/include/{capnp,sandstorm}
test -e /usr/include/capnp/c++.capnp && cp /usr/include/capnp/*.capnp bundle/usr/include/capnp
test -e /usr/local/include/capnp/c++.capnp && cp /usr/local/include/capnp/*.capnp bundle/usr/include/capnp
cp src/sandstorm/*.capnp bundle/usr/include/sandstorm

# Copy over all necessary shared libraries.
(ldd bundle/bin/* $(find bundle -name '*.node') || true) | grep -o '[[:space:]]/[^ ]*' | sort | uniq |
    (while read file; do mkdir -p bundle$(dirname $file); cp $file bundle$file; done)

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
    whoami xargs xz xzcat yes zcat; do
  ln -s busybox bundle/bin/$command
done

# Set up /var
mkdir -p bundle/var/{log,pid,mongo} bundle/var/sandstorm/{apps,grains,downloads}

# Create mount points
mkdir -p bundle/{dev,proc,tmp}

# Create run script.
cat > bundle/run.sh << '__EOF__'
#! /bin/sh

set -eu

case ${1:-phase0} in
  phase0 )
    if [ $(whoami) != root ]; then
      echo "Please run as root." >&2
      exit 1
    fi
    unshare -m $0 phase1
    exit $?
    ;;

  phase1 )
    ROOT=$(dirname $(readlink -f $(which $0)))
    mount --make-rprivate /
    mount -B /dev $ROOT/dev
    mount -t proc proc $ROOT/proc
    USERSPEC=$(stat -c '%u:%g' $(which $0))
    exec chroot --userspec=$USERSPEC $ROOT /$(basename $0) phase2
    exit 1  # can't actually get here
    ;;

  phase2 )
    export MONGO_URL='mongodb://127.0.0.1:3002/meteor'
    export ROOT_URL='http://127.0.0.1:3000'
    export LD_LIBRARY_PATH='/usr/local/lib:/usr/lib:/lib'

    /bin/mongod --fork --port 4002 --dbpath /var --noauth --bind_ip 127.0.0.1 \
        --nohttpinterface --noprealloc --nopreallocj --logpath /var/log/mongo.log

    PORT=3000 /bin/node main.js
    ;;
  
  esac
fi
__EOF__
chmod +x bundle/run.sh


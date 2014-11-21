#! /bin/bash

# This script installs the Sandstorm Personal Cloud Server on your Linux
# machine. You can run the latest installer directly from the web by doing:
#
#     curl https://install.sandstorm.io | bash
#
# Alternatively, if it makes you feel better, you can download and run the
# script:
#
#     wget https://install.sandstorm.io/install.sh
#     bash install.sh
#
# This script only modifies your system in the following ways:
# - Install Sandstorm into the directory you choose, typically /opt/sandstorm.
# - Optionally add an initscript to /etc/init.d/sandstorm.
# - Add commands "sandstorm" and "spk" to /usr/local/bin.
#
# The script will ask you whether you're OK with giving it root privileges.
# If you refuse, the script can still install Sandstorm (to a directory you
# own), but will not be able to install the initscript or shortcut commands,
# and the dev tools will not work (due to limitations with using FUSE in a
# sandbox).
#
# This script downloads an installs binaries. This means that to use this
# script, you need to trust that the authors are not evil, or you must use
# an isolated machine or VM. Of course, since the Sandstorm authors'
# identities are widely known, if they did try to do anything evil, you
# could easily get them arrested. That said, if you'd rather install from
# 100% auditable source code, please check out the Github repository instead.
#
# All downloads occur over HTTPS.

if test -z "$BASH_VERSION"; then
  echo "Please run this script using bash, not sh or any other shell." >&2
  exit 1
fi

# We wrap the entire script in a big function which we only call at the very end, in order to
# protect against the possibility of the connection dying mid-script. This protects us against
# the problem described in this blog post:
#   http://blog.existentialize.com/dont-pipe-to-your-shell.html
_() {

set -euo pipefail

SCRIPT_NAME=$1
shift

usage() {
  echo "usage: $SCRIPT_NAME [-d] [-e] [-u] [<bundle>]" >&2
  echo "If <bundle> is provided, it must be the name of a Sandstorm bundle file," >&2
  echo "like 'sandstorm-123.tar.xz', which will be installed. Otherwise, the script" >&2
  echo "downloads a bundle from the internet via HTTP." >&2
  echo '' >&2
  echo 'If -d is specified, the script does not prompt for input; it accepts all defaults.' >&2
  echo 'If -e is specified, default to listening on an external interface, not merely loopback.' >&2
  echo 'If -u is specified, default to avoiding root priviliges. Note that the dev tools only work if the server as root privileges.' >&2
  exit 1
}

USE_DEFAULTS="no"
USE_EXTERNAL_INTERFACE="no"
while getopts ":deu" opt; do
  case $opt in
    d)
      USE_DEFAULTS="yes"
      ;;
    e)
      USE_EXTERNAL_INTERFACE="yes"
      ;;
    u)
      PREFER_ROOT=no
      ;;
    *)
      usage
      ;;
  esac
done

declare -a ORIGINAL_ARGS
ORIGINAL_ARGS=("$@")

# Pass positional parameters through
shift "$((OPTIND - 1))"

if [ $# = 1 ] && [[ ! $1 =~ ^- ]]; then
  BUNDLE_FILE="$1"
elif [ $# != 0 ]; then
  usage
fi

error() {
  if [ $# != 0 ]; then
    echo -en '\e[0;31m' >&2
    echo "$@" | fold -s >&2
    echo -en '\e[0m' >&2
  fi
}

fail() {
  error "$@"
  echo "*** INSTALLATION FAILED ***" >&2
  echo "Report bugs at: http://github.com/sandstorm-io/sandstorm" >&2
  exit 1
}

if [ "no" = "$USE_DEFAULTS" ] && [ ! -t 1 ]; then
  fail "This script is interactive. Please run it on a terminal."
fi

# Hack: If the script is being read in from a pipe, then FD 0 is not the terminal input. But we
#   need input from the user! We just verified that FD 1 is a terminal, therefore we expect that
#   we can actually read from it instead. However, "read -u 1" in a script results in
#   "Bad file descriptor", even though it clearly isn't bad (weirdly, in an interactive shell,
#   "read -u 1" works fine). So, we clone FD 1 to FD 3 and then use that -- bash seems OK with
#   this.
exec 3<&1

prompt() {
  local VALUE

  # Hack: We read from FD 3 because when reading the script from a pipe, FD 0 is the script, not
  #   the terminal. We checked above that FD 1 (stdout) is in fact a terminal and then dup it to
  #   FD 3, thus we can input from FD 3 here.
  if [ "yes" = "$USE_DEFAULTS" ] ; then
    # Print the default.
    echo "$2"
    return
  fi

  echo -en '\e[0;34m' >&3
  echo -n "$1 [$2]" >&3
  echo -en '\e[0m ' >&3
  read -u 3 VALUE
  if [ -z "$VALUE" ]; then
    VALUE=$2
  fi
  echo "$VALUE"
}

prompt-yesno() {
  while true; do
    local VALUE=$(prompt "$@")

    case $VALUE in
      y | Y | yes | YES | Yes )
        return 0
        ;;
      n | N | no | NO | No )
        return 1
        ;;
    esac

    echo "*** Please answer \"yes\" or \"no\"."
  done
}

if [ "$(uname)" != Linux ]; then
  fail "Sorry, the Sandstorm server only runs on Linux."
fi

if [ "$(uname -m)" != x86_64 ]; then
  fail "Sorry, tha Sandstorm server currently only runs on x86_64 machines."
fi

KVERSION=( $(uname -r | grep -o '^[0-9.]*' | tr . ' ') )

if (( KVERSION[0] < 3 || (KVERSION[0] == 3 && KVERSION[1] < 13) )); then
  error "Detected Linux kernel version: $(uname -r)"
  fail "Sorry, your kernel is too old to run Sandstorm. We require kernel" \
       "version 3.13 or newer."
fi

if [ -z "${BUNDLE_FILE:-}" ]; then
  which curl > /dev/null|| fail "Please install curl(1). Sandstorm uses it to download updates."
fi

which tar > /dev/null || fail "Please install tar(1)."
which xz > /dev/null || fail "Please install xz(1). (Package may be called 'xz-utils'.)"

# ========================================================================================
# Validate bundle file, if provided

if [ -n "${BUNDLE_FILE:-}" ]; then
  # Read the first filename out of the bundle, which should be the root directory name.
  # We use "|| true" here because tar is going to SIGPIPE when `head` exits.
  BUNDLE_DIR=$( (tar Jtf "$BUNDLE_FILE" || true) | head -n 1)
  if [[ ! "$BUNDLE_DIR" =~ sandstorm-([0-9]+)/ ]]; then
    fail "$BUNDLE_FILE: Not a valid Sandstorm bundle"
  fi

  BUILD=${BASH_REMATCH[1]}

  # We're going to change directory, so note the bundle's full name.
  BUNDLE_FILE=$(readlink -f "$BUNDLE_FILE")
fi

# ========================================================================================

DIR=/opt/sandstorm

if [ $(id -u) != 0 ]; then
  echo "If you plan to use this Sandstorm instance for app development, you will need"
  echo "to install Sandstorm as root, because Linux does not yet support mounting"
  echo "FUSE filesystems in a UID namespace. Otherwise, you can install and run it as"
  echo "a regular user. Even if installed as root, the main server processes will"
  echo "never run as root. Either way, Sandstorm runs inside a directory you choose"
  echo "and will not mess with the rest of your system."

  if prompt-yesno "Install as root?" "${PREFER_ROOT:-yes}"; then
    if [ "$(basename $SCRIPT_NAME)" == bash ]; then
      # Probably ran like "curl https://sandstorm.io/install.sh | bash"
      echo "Re-running script as root..."
      exec sudo bash -euo pipefail -c 'curl -fs https://install.sandstorm.io | bash'
    elif [ "$(basename $SCRIPT_NAME)" == install.sh ] && [ -e "$0" ]; then
      # Probably ran like "bash install.sh" or "./install.sh".
      echo "Re-running script as root..."
      if [ ${#ORIGINAL_ARGS[@]} = 0 ]; then
        exec sudo bash "$SCRIPT_NAME"
      else
        exec sudo bash "$SCRIPT_NAME" "${ORIGINAL_ARGS[@]}"
      fi
    fi

    # Don't know how to run the script. Let the user figure it out.
    fail "Oops, I couldn't figure out how to switch to root. Please re-run the installer as root."
  fi

  DIR=$HOME/sandstorm
fi

if [ -e /proc/sys/kernel/unprivileged_userns_clone ] && \
   [ "$(</proc/sys/kernel/unprivileged_userns_clone)" == "0" ]; then
  echo "Sandstorm requires sysctl kernel.unprivileged_userns_clone to be enabled."
  echo "Currently, it is not enabled on your system."
  if prompt-yesno "Shall I enable it for you?" yes; then
    if [ ! -e /etc/sysctl.conf ]; then
      fail "Can't find /etc/sysctl.conf. I don't know how to set sysctls" \
           "permanently on your system. Please set it manually and try again."
    fi
    cat >> /etc/sysctl.conf << __EOF__

# Enable non-root users to create sandboxes (needed by Sandstorm).
kernel.unprivileged_userns_clone = 1
__EOF__
    sysctl -w kernel.unprivileged_userns_clone=1
  else
    fail "OK, please enable this option yourself and try again."
  fi
fi

DIR=$(prompt "Where would you like to put Sandstorm?" "$DIR")

if [ -e "$DIR" ]; then
  echo "$DIR already exists. Sandstorm will assume ownership of all contents."
  prompt-yesno "Is this OK?" yes || fail
fi

mkdir -p "$DIR"
cd "$DIR"

# ========================================================================================
# Write config

writeConfig() {
  while [ $# -gt 0 ]; do
    eval echo "$1=\$$1"
    shift
  done
}

# TODO(someday): Ask what channel to use. Currently there is only one channel.
CHANNEL=dev

if [ -e sandstorm.conf ]; then
  echo "Found existing sandstorm.conf. Using it."
  . sandstorm.conf
  if [ "${SERVER_USER:+set}" != set ]; then
    fail "Existing config does not set SERVER_USER. Please fix or delete it."
  fi
  if [ "${UPDATE_CHANNEL:-none}" != none ]; then
    CHANNEL=$UPDATE_CHANNEL
  fi
else
  if [ $(id -u) = 0 ]; then
    SERVER_USER=$(prompt "Local user account to run server under:" sandstorm)

    while [ "$SERVER_USER" = root ]; do
      echo "Sandstorm cannot run as root!"
      SERVER_USER=$(prompt "Local user account to run server under:" sandstorm)
    done

    if ! id "$SERVER_USER" > /dev/null 2>&1; then
      if prompt-yesno "User account '$SERVER_USER' doesn't exist. Create it?" yes; then
        useradd --system "$SERVER_USER"

        echo "Note: Sandstorm's storage will only be accessible to the group '$SERVER_USER'."

        if [ -n "${SUDO_USER:-}" ]; then
          if prompt-yesno "Add user '$SUDO_USER' to group '$SERVER_USER'?" no; then
            usermod -a -G "$SERVER_USER" "$SUDO_USER"
            echo "Added. Don't forget that group changes only apply at next login."
          fi
        fi
      fi
    else
      echo "Note: Sandstorm's storage will only be accessible to the group '$(id -gn $SERVER_USER)'."
    fi
  else
    SERVER_USER=$(id -un)
  fi

  PORT=$(prompt "Server main HTTP port:" 6080)

  while [ "$PORT" -lt 1024 ]; do
    echo "Ports below 1024 require root privileges. Sandstorm does not run as root."
    echo "To use port $PORT, you'll need to set up a reverse proxy like nginx that "
    echo "forwards to the internal higher-numbered port. The Sandstorm git repo "
    echo "contains an example nginx config for this."
    PORT=$(prompt "Server main HTTP port:" 6080)
  done

  MONGO_PORT=$(prompt "Database port (choose any unused port):" "$((PORT + 1))")

  # Figure out if we want to listen on internal vs. external interfaces.
  if [ "yes" != "$USE_EXTERNAL_INTERFACE" ]; then
    if prompt-yesno "Expose to localhost only?" yes ; then
      USE_EXTERNAL_INTERFACE="no"
    else
      USE_EXTERNAL_INTERFACE="yes"
    fi
  fi

  if [ "yes" = "$USE_EXTERNAL_INTERFACE" ]; then
    BIND_IP=0.0.0.0
    SS_HOSTNAME=$(hostname -f)
  else
    BIND_IP=127.0.0.1
    SS_HOSTNAME=local.sandstorm.io
    echo "Note: local.sandstorm.io maps to 127.0.0.1, i.e. your local machine. For"
    echo "reasons that will become clear in the next step, you should use this"
    echo "instead of 'localhost'."
  fi
  BASE_URL=$(prompt "URL users will enter in browser:" "http://$SS_HOSTNAME:$PORT")

  if [[ "$BASE_URL" =~ ^http://localhost(|:[0-9]*)(/.*)?$ ]]; then
    DEFAULT_WILDCARD=*.local.sandstorm.io${BASH_REMATCH[1]}
  elif [[ "$BASE_URL" =~ ^[^:/]*://(.*)$ ]]; then
    DEFAULT_WILDCARD=*.${BASH_REMATCH[1]}
  else
    DEFAULT_WILDCARD=
  fi

  echo "Sandstorm requires you to set up a wildcard DNS entry pointing at the server."
  echo "This allows Sandstorm to allocate new hosts on-the-fly for sandboxing purposes."
  echo "Please enter a DNS hostname containing a '*' which maps to your server. For "
  echo "example, if you have mapped *.foo.example.com to your server, you could enter"
  echo "\"*.foo.example.com\". You can also specify that hosts should have a special"
  echo "prefix, like \"ss-*.foo.example.com\". Note that if your server's main page"
  echo "is served over SSL, the wildcard address must support SSL as well, which"
  echo "implies that you must have a wildcard certificate. For local-machine servers,"
  echo "we have mapped *.local.sandstorm.io to 127.0.0.1 for your convenience, so you"
  echo "can use \"*.local.sandstorm.io\" here. If you are serving off a non-standard"
  echo "port, you must include it here as well."
  WILDCARD_HOST=$(prompt "Wildcard host:" "$DEFAULT_WILDCARD")

  while ! [[ "$WILDCARD_HOST" =~ ^[^*]*[*][^*]*$ ]]; do
    error "Invalid wildcard host. It must contain exactly one asterisk."
    WILDCARD_HOST=$(prompt "Wildcard host:" "$DEFAULT_WILDCARD")
  done

  echo "If you want to be able to send e-mail invites and password reset messages, "
  echo "enter a mail server URL of the form 'smtp://user:pass@host:port'.  Leave "
  echo "blank if you don't care about these features."
  MAIL_URL=$(prompt "Mail URL:" "")

  if prompt-yesno "Automatically keep Sandstorm updated?" yes; then
    UPDATE_CHANNEL=$CHANNEL
  else
    UPDATE_CHANNEL=none
  fi

  writeConfig SERVER_USER PORT MONGO_PORT BIND_IP BASE_URL WILDCARD_HOST MAIL_URL UPDATE_CHANNEL > sandstorm.conf

  echo
  echo "Config written to $PWD/sandstorm.conf."
fi

# ========================================================================================
# Download

if [ -z "${BUNDLE_FILE:-}" ]; then
  echo "Finding latest build for $CHANNEL channel..."
  BUILD=$(curl -fs "https://install.sandstorm.io/$CHANNEL?from=0&type=install")
  BUILD_DIR=sandstorm-$BUILD

  if [[ ! "$BUILD" =~ ^[0-9]+$ ]]; then
    fail "Server returned invalid build number: $BUILD"
  fi

  do-download() {
    rm -rf $BUILD_DIR
    local URL="https://dl.sandstorm.io/sandstorm-$BUILD.tar.xz"
    echo "Downloading: $URL"
    curl -f "$URL" | tar Jxo

    if [ ! -e "$BUILD_DIR" ]; then
      fail "Bad package -- did not contain $BUILD_DIR directory."
    fi
  }

  if [ -e $BUILD_DIR ]; then
    echo "$BUILD_DIR is already present. Should I use it or re-download?"
    if ! prompt-yesno "Use existing copy?" yes; then
      do-download
    fi
  else
    do-download
  fi

else
  # Use the specified local bundle, which we already validated earlier.

  if [ $BUILD = 0 ]; then
    BUILD_DIR=sandstorm-custom.$(date +'%Y-%m-%d_%H-%M-%S')
  else
    BUILD_DIR=sandstorm-$BUILD
  fi

  rm -rf "$BUILD_DIR"
  mkdir "$BUILD_DIR"
  (cd "$BUILD_DIR" && tar Jxof "$BUNDLE_FILE" --strip=1)
fi

# ========================================================================================
# Setup

GROUP=$(id -g $SERVER_USER)

# Make var directories.
mkdir -p var/{log,pid,mongo} var/sandstorm/{apps,grains,downloads}

# Create useful symlinks.
ln -sfT $BUILD_DIR latest
ln -sfT latest/sandstorm sandstorm

if [ $(id -u) != 0 ]; then
  # Installed as non-root. Skip ownership stuff.

  echo "Setup complete. To start your server now, run:"
  echo "  $DIR/sandstorm start"
  echo "It will then run at:"
  echo "  ${BASE_URL:-(unknown; bad config)}"
  echo "To learn how to control the server, run:"
  echo "  $DIR/sandstorm help"

else
  # Installed as root.

  # Set ownership of files.  We want the dirs to be root:sandstorm but the contents to be
  # sandstorm:sandstorm.
  chown -R $SERVER_USER:$GROUP var/{log,pid,mongo} var/sandstorm/{apps,grains,downloads}
  chown root:$GROUP var/{log,pid,mongo} var/sandstorm/{apps,grains,downloads}
  chmod -R g=rwX,o= var/{log,pid,mongo} var/sandstorm/{apps,grains,downloads}

  # Don't allow listing grain IDs directly.  (At the moment, this is faux security since
  # an attacker could just read the database, but maybe that will change someday...)
  chmod g-r var/sandstorm/grains

  # Install tools.
  ln -sfT $PWD/sandstorm /usr/local/bin/sandstorm
  ./sandstorm devtools

  # Note: Ubuntu may have /etc/systemd even when not configured to use systemd.
  if [ -d /etc/systemd/system ] && which systemctl > /dev/null; then
    SYSTEMD_UNIT="sandstorm.service"

    if prompt-yesno "Start sandstorm at system boot?" yes; then
      if systemctl list-unit-files | grep -q $SYSTEMD_UNIT; then
        systemctl stop sandstorm || true
      fi

      # the init.d logic simply overwrites the init script if it exists, adopt that here
      for SYSTEMD_UNIT_PATH in /etc/systemd/system /run/systemd/system /usr/lib/systemd/system; do
        if [ -e $SYSTEMD_UNIT_PATH/$SYSTEMD_UNIT ]; then
          rm $SYSTEMD_UNIT_PATH/$SYSTEMD_UNIT
        fi
      done

      cat > /etc/systemd/system/$SYSTEMD_UNIT << __EOF__
[Unit]
Description=Sandstorm server
After=local-fs.target remote-fs.target network.target
Requires=local-fs.target remote-fs.target network.target

[Service]
Type=forking
ExecStart=$PWD/sandstorm start
ExecStop=$PWD/sandstorm stop

[Install]
WantedBy=multi-user.target
__EOF__
      systemctl enable sandstorm
      systemctl start sandstorm

      echo "Setup complete. Your server should be running at:"
      echo "  ${BASE_URL:-(unknown; bad config)}"
      echo "To learn how to control the server, run:"
      echo "  sandstorm help"
      exit 0
    fi
  elif [ -e /etc/init.d ]; then
    if prompt-yesno "Start sandstorm at system boot?" yes; then
      if [ -e /etc/init.d/sandstorm ]; then
        service sandstorm stop || true
      fi

      cat > /etc/init.d/sandstorm << __EOF__
#! /bin/bash
### BEGIN INIT INFO
# Provides:          sandstorm
# Required-Start:    \$local_fs \$remote_fs \$networking \$syslog
# Required-Stop:     \$local_fs \$remote_fs \$networking \$syslog
# Default-Start:     2 3 4 5
# Default-Stop:      0 1 6
# Short-Description: starts Sandstorm personal cloud server
### END INIT INFO

DESC="Sandstorm server"
DAEMON=$PWD/sandstorm

# The Sandstorm runner supports all the common init commands directly.
# We use -a to set the program name to make help text look nicer.
# This requires bash, though.
exec -a "service sandstorm" \$DAEMON "\$@"
__EOF__
      chmod +x /etc/init.d/sandstorm

      update-rc.d sandstorm defaults

      service sandstorm start

      echo "Setup complete. Your server should be running at:"
      echo "  ${BASE_URL:-(unknown; bad config)}"
      echo "To learn how to control the server, run:"
      echo "  sandstorm help"
      exit 0
    fi
  else
    echo "Note: I don't know how to set up sandstorm to auto-run at startup on"
    echo "  your system. :("
    echo
  fi

  echo "Setup complete. To start your server now, run:"
  echo "  sudo sandstorm start"
  echo "It will then run at:"
  echo "  ${BASE_URL:-(unknown; bad config)}"
  echo "To learn how to control the server, run:"
  echo "  sandstorm help"
fi

}

# Now that we know the whole script has downloaded, run it.
_ "$0" "$@"

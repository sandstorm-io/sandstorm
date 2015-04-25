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

# Declare an array so that we can capture the original arguments.
declare -a ORIGINAL_ARGS

# Define I/O helper functions.
error() {
  if [ $# != 0 ]; then
    echo -en '\e[0;31m' >&2
    echo "$@" | (fold -s || cat) >&2
    echo -en '\e[0m' >&2
  fi
}

fail() {
  error "$@"
  echo "*** INSTALLATION FAILED ***" >&2
  echo "Report bugs at: http://github.com/sandstorm-io/sandstorm" >&2
  exit 1
}

# writeConfig takes a list of shell variable names and saves them, and
# their contents, to stdout. Therefore, the caller should redirect its
# output to a config file.
writeConfig() {
  while [ $# -gt 0 ]; do
    eval echo "$1=\$$1"
    shift
  done
}

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

# Define global variables that the install script will use to mark its
# own progress.

USE_DEFAULTS="no"
USE_EXTERNAL_INTERFACE="no"
USE_SANDCATS="no"
SANDCATS_SUCCESSFUL="no"
CURRENTLY_UID_ZERO="no"
PREFER_ROOT="yes"

# Defaults for some config options, so that if the user requests no
# prompting, they get these values.
DEFAULT_PORT=6080
DEFAULT_DIR_FOR_ROOT="/opt/sandstorm"
DEFAULT_DIR_FOR_NON_ROOT="$HOME/sandstorm"
DEFAULT_UPDATE_CHANNEL="dev"
DEFAULT_SERVER_USER="sandstorm"
SANDCATS_BASE_DOMAIN="${OVERRIDE_SANDCATS_BASE_DOMAIN:-sandcats.io}"
ALLOW_DEV_ACCOUNTS="false"

# Define functions for each stage of the install process.

usage() {
  echo "usage: $SCRIPT_NAME [-c] [-d] [-e] [-u] [<bundle>]" >&2
  echo "If <bundle> is provided, it must be the name of a Sandstorm bundle file," >&2
  echo "like 'sandstorm-123.tar.xz', which will be installed. Otherwise, the script" >&2
  echo "downloads a bundle from the internet via HTTP." >&2
  echo '' >&2
  echo 'If -d is specified, the auto-installs with defaults suitable for app development.' >&2
  echo 'If -e is specified, default to listening on an external interface, not merely loopback.' >&2
  echo 'If -u is specified, default to avoiding root priviliges. Note that the dev tools only work if the server as root privileges.' >&2
  exit 1
}

detect_current_uid() {
  if [ $(id -u) = 0 ]; then
    CURRENTLY_UID_ZERO="yes"
  fi
}

handle_args() {
  SCRIPT_NAME=$1
  shift

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

  # Keep a copy of the ORIGINAL_ARGS so that, when re-execing ourself,
  # we can pass them in.
  ORIGINAL_ARGS=("$@")

  # Pass positional parameters through
  shift "$((OPTIND - 1))"

  if [ $# = 1 ] && [[ ! $1 =~ ^- ]]; then
    BUNDLE_FILE="$1"
  elif [ $# != 0 ]; then
    usage
  fi
}

rerun_script_as_root() {
  # Note: This function assumes that the caller has requested
  # permission to use sudo!

  # Pass $@ here to enable the caller to provide environment
  # variables to bash, which will affect the execution plan of
  # the resulting install script run.

  if [ "$(basename $SCRIPT_NAME)" == bash ]; then
    # Probably ran like "curl https://sandstorm.io/install.sh | bash"
    echo "Re-running script as root..."
    exec sudo bash -euo pipefail -c "curl -fs https://install.sandstorm.io | $@ bash"
  elif [ "$(basename $SCRIPT_NAME)" == install.sh ] && [ -e "$0" ]; then
    # Probably ran like "bash install.sh" or "./install.sh".
    echo "Re-running script as root..."
    if [ ${#ORIGINAL_ARGS[@]} = 0 ]; then
      exec sudo "$@" bash "$SCRIPT_NAME"
    else
      exec sudo "$@" bash "$SCRIPT_NAME" "${ORIGINAL_ARGS[@]}"
    fi
  fi

  # Don't know how to run the script. Let the user figure it out.
  fail "Oops, I couldn't figure out how to switch to root. Please re-run the installer as root."

}

assert_on_terminal() {
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
}

assert_linux_x86_64() {
  if [ "$(uname)" != Linux ]; then
    fail "Sorry, the Sandstorm server only runs on Linux."
  fi

  if [ "$(uname -m)" != x86_64 ]; then
    fail "Sorry, tha Sandstorm server currently only runs on x86_64 machines."
  fi
}

assert_usable_kernel() {
  KVERSION=( $(uname -r | grep -o '^[0-9.]*' | tr . ' ') )

  if (( KVERSION[0] < 3 || (KVERSION[0] == 3 && KVERSION[1] < 13) )); then
    error "Detected Linux kernel version: $(uname -r)"
    fail "Sorry, your kernel is too old to run Sandstorm. We require kernel" \
         "version 3.13 or newer."
  fi
}

assert_userns_clone() {
  if [ -e /proc/sys/kernel/unprivileged_userns_clone ]; then
    if [ "$(</proc/sys/kernel/unprivileged_userns_clone)" == "0" ]; then
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
        sysctl -w kernel.unprivileged_userns_clone=1 || fail "'sysctl -w" \
          "kernel.unprivileged_userns_clone=1' failed. If you are inside docker, please run the"
          "command manually inside your host and update /etc/sysctl.conf."
      else
        fail "OK, please enable this option yourself and try again."
      fi
    fi
  else
    # Figure out if user namespaces work at all.
    rm -f /tmp/sandstorm-userns-test /tmp/sandstorm-userns-test.c
    cat > /tmp/sandstorm-userns-test.c << __EOF__
#define _GNU_SOURCE
#include <sched.h>
#include <sys/types.h>
#include <unistd.h>
#include <stdio.h>

int main() {
  /* We're trying to verify that UID namespaces work when not root, so make sure we're
   * not root. */
  if (getuid() == 0) {
    /* Number here doesn't really matter, but 65534 is usually "nobody". */
    if (setuid(65534) < 0) {
      perror("setuid");
      return 1;
    }
  }

  /* OK, let's see if we can create a UID namespace. */
  if (unshare(CLONE_NEWUSER) < 0) {
    /* Nope. */
    perror("unshare");
    return 1;
  }

  return 0;
}
__EOF__
    if cc /tmp/sandstorm-userns-test.c -o /tmp/sandstorm-userns-test; then
      if ! /tmp/sandstorm-userns-test; then
        rm -f /tmp/sandstorm-userns-test /tmp/sandstorm-userns-test.c
        fail "Your kernel does not appear to be compiled with" \
             "support for unprivileged user namespaces (CONFIG_USER_NS=y), or something else is" \
             "preventing creation of user namespaces. This feature is critical for sandboxing." \
             "Arch Linux is known to ship with a kernel that disables this feature; if you are" \
             "using Arch, you will unfortunately need to compile your own kernel (see" \
             "https://bugs.archlinux.org/task/36969). If you are not using Arch, and don't" \
             "know why your system wouldn't have user namespaces, please file a bug against" \
             "Sandstorm so we can figure out what happened."
      fi
    else
      echo "WARNING: Couldn't compile user namespace test. We'll assume user namespaces" >&2
      echo "  are enabled." >&2
    fi

    rm -f /tmp/sandstorm-userns-test /tmp/sandstorm-userns-test.c
  fi
}

assert_dependencies() {
  if [ -z "${BUNDLE_FILE:-}" ]; then
    which curl > /dev/null|| fail "Please install curl(1). Sandstorm uses it to download updates."
  fi

  if [ "yes" = "$USE_SANDCATS" ] ; then
    # To set up sandcats, we need `openssl` on the path. Check for that,
    # and if it is missing, bail out and tell the user they have to
    # install it.
    which openssl > /dev/null|| fail "Please install openssl(1). Sandstorm uses it for the Sandcats.io dynamic DNS service."
  fi

  which tar > /dev/null || fail "Please install tar(1)."
  which xz > /dev/null || fail "Please install xz(1). (Package may be called 'xz-utils'.)"
}

assert_valid_bundle_file() {
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
}

detect_init_system() {
  # We start out by not knowing which init system is in use.
  INIT_SYSTEM="unknown"

  # We look for systemd, since we have a nice way to generate a unit file.
  if grep -q systemd /proc/1/comm; then
    INIT_SYSTEM="systemd"
    return
  fi

  # We look for sysvinit, as a convenient fallback. Note that this
  # should work fine with Upstart (on e.g. Ubuntu 14.04), too.
  if [ -e /etc/init.d ]; then
    INIT_SYSTEM="sysvinit"
    return
  fi

  # If we got this far, and we couldn't figure out the init system
  # in use, that's life.
}

choose_install_mode() {
  if [ "yes" = "$USE_DEFAULTS" ] ; then
    CHOSEN_INSTALL_MODE=2  # dev server mode
  fi

  if [ -z "${CHOSEN_INSTALL_MODE:-}" ]; then
    echo "Sandstorm makes it easy to run web apps on your own server. You can have:"
    echo ""
    echo "1. A full server with automatic setup (press enter to accept this default)"
    echo "2. A development server, for writing apps."
    echo ""
    CHOSEN_INSTALL_MODE=$(prompt "How are you going to use this Sandstorm install?" "1")
  fi

  if [ "1" = "$CHOSEN_INSTALL_MODE" ] ; then
    full_server_install
  else
    dev_server_install
  fi
}

dev_server_install() {
  # Use these settings for a dev-server-oriented install.
  #
  # Users will find themselves going through this flow if they
  # manually choose a dev-server-related flow, but also if they pass
  # -d on the command line. (The Vagrantfile and the test suite both
  # use -d. The test suite runs install.sh with -d -u.)
  #
  # A "dev server install" must be run as root, unless you pass
  # -u. That's because app development (aka spk dev) requires running
  # as root, at the moment.

  if [ "yes" = "$PREFER_ROOT" ] && [ "no" = "$CURRENTLY_UID_ZERO" ] ; then
    # We are not root, but we would like to be root.
    echo "If you want app developer mode for a Sandstorm install, you need root"
    echo "due to limitations in the Linux kernel."
    echo ""

    echo "To set up Sandstorm, we will need to use sudo."
    echo "Rest assured that Sandstorm itself won't run as root."

    # If we are running in USE_DEFAULTS mode, then it is not OK to ask
    # for permission to use sudo.
    if [ "yes" = "$USE_DEFAULTS" ] ; then
      ACCEPTED_SUDO_FOR_DEV_SERVER="no"
    else
      if prompt-yesno "OK to continue?" "yes" ; then
        ACCEPTED_SUDO_FOR_DEV_SERVER="yes"
      else
        ACCEPTED_SUDO_FOR_DEV_SERVER="no"
      fi
    fi

    if [ "yes" = "$ACCEPTED_SUDO_FOR_DEV_SERVER" ] ; then
      rerun_script_as_root CHOSEN_INSTALL_MODE=2
    else
      # Print a message that allows people to make an informed decision.
      echo "If you are OK with a local Sandstorm install for testing"
      echo "but not app development, re-run install.sh with -u to bypass this message."
      fail "For developer mode to work, the script needs root, or read above to bypass."
    fi
  fi

  # If they did not pass -d, then let them opt into that.
  if [ "yes" != "$USE_DEFAULTS" ] ; then
    echo "We're going to:"
    echo ""
    echo "* Install Sandstorm in ${DEFAULT_DIR_FOR_ROOT}."
    echo "* Automatically keep Sandstorm up-to-date."
    echo "* Create a service user ($DEFAULT_SERVER_USER) that owns Sandstorm's files."
    echo "* Add you ($USER) to the $DEFAULT_SERVER_USER group so you can read/write app data."
    echo "* Expose the service only on localhost aka local.sandstorm.io, not the public Internet."
    echo "* Enable 'dev accounts', for easy developer login."
    if [ "unknown" == "$INIT_SYSTEM" ]; then
      echo "*** WARNING: Could not detect how to run Sandstorm at startup on your system. ***"
    else
        echo "* Configure Sandstorm to start on System boot (with $INIT_SYSTEM)."
    fi
    echo ""

    if prompt-yesno "Press enter to accept defaults. Type 'no' to customize." "yes" ; then
      USE_DEFAULTS="yes"
    else
      echo ""
      echo "OK. We will prompt you with every question."
      echo ""
    fi

  fi

  if [ "yes" = "$USE_DEFAULTS" ] ; then
    # Use the default UPDATE_CHANNEL for auto-updates.
    UPDATE_CHANNEL="$DEFAULT_UPDATE_CHANNEL"

    # Bind to localhost.
    USE_EXTERNAL_INTERFACE="no"

    # Start the service at boot, if we can.
    START_AT_BOOT="yes"

    # Do not ask questions about our dynamic DNS service.
    USE_SANDCATS="no"

    # Reasonable default ports.
    PORT="${DEFAULT_PORT}"
    # Allow the mongo prompting part to determine a reasonable
    # MONGO_PORT.

    # Use the ALLOW_DEV_ACCOUNTS feature, which allows people to log
    # into a Sandstorm instance without setting up any accounts.
    ALLOW_DEV_ACCOUNTS="yes"

    # Do not bother setting a DESIRED_SERVER_USER. This way, the
    # existing prompting will pick if this should be "sandstorm" (which
    # it should be if we're running the install script as root) or the
    # currently-logged-in user (which it should be if we're not root).

    # Do not bother setting a DIR. This way, the existing prompting will
    # pick between /opt/sandstorm and $HOME/sandstorm, depending on if
    # the install is being done as root or not.
  fi
}

full_server_install() {
  if [ "0" != "${ACCEPTED_FULL_SERVER_INSTALL:-}" ]; then
    echo "We're going to:"
    echo ""
    echo "* Install Sandstorm in $DEFAULT_DIR_FOR_ROOT"
    echo "* Automatically keep Sandstorm up-to-date"
    echo "* Create a service user ($DEFAULT_SERVER_USER) that owns Sandstorm's files"
    if [ "unknown" == "$INIT_SYSTEM" ]; then
      echo "*** WARNING: Could not detect how to run Sandstorm at startup on your system. ***"
    else
      echo "* Configure Sandstorm to start on System boot (with $INIT_SYSTEM)"
    fi
    echo ""

    # If we're not root, we will ask if it's OK to use sudo.
    if [ "yes" != "$CURRENTLY_UID_ZERO" ]; then
      echo "To set up Sandstorm, we will need to use sudo."
    else
      echo "Rest assured that Sandstorm itself won't run as root."
    fi

    prompt-yesno "OK to continue?" "yes"
    ACCEPTED_FULL_SERVER_INSTALL="$?"

    # If they are OK continuing, and the script is not running as root
    # at the moment, then re-run ourselves as root.
    #
    # Pass along enough information so that the script will keep
    # executing smoothly, so the user doesn't have to re-answer
    # questions.
    if [ "yes" != "$CURRENTLY_UID_ZERO" ] ; then
      if [ "$ACCEPTED_FULL_SERVER_INSTALL" ] ; then
        rerun_script_as_root CHOSEN_INSTALL_MODE=1 \
                             ACCEPTED_FULL_SERVER_INSTALL=0 \
                             OVERRIDE_SANDCATS_BASE_DOMAIN="${OVERRIDE_SANDCATS_BASE_DOMAIN:-}" \
                             OVERRIDE_SANDCATS_API_BASE="${OVERRIDE_SANDCATS_API_BASE:-}" \
                             OVERRIDE_SANDCATS_CURL_PARAMS="${OVERRIDE_SANDCATS_CURL_PARAMS:-}"
      else
        fail "Automatic server setup requires root. Try installing in development mode instead."
      fi
    fi
  fi

  # Accepting this indicates a few things.
  if [ "${ACCEPTED_FULL_SERVER_INSTALL}" ]; then
    UPDATE_CHANNEL="$DEFAULT_UPDATE_CHANNEL"
    DIR="$DEFAULT_DIR_FOR_ROOT"
    USE_EXTERNAL_INTERFACE="yes"
    USE_SANDCATS="yes"
    START_AT_BOOT="yes"
    DESIRED_SERVER_USER="$DEFAULT_SERVER_USER"
    PORT="6080"
    MONGO_PORT="6081"
  else
    fail "If you prefer a more manual setup experience, try installing in development mode."
  fi
}

sandcats_configure() {
  # We generate the public key before prompting for a desired hostname
  # so that when the user presses enter, we can try to register the
  # hostname, and if that succeeds, we are totally done. This avoids a
  # possible time-of-check-time-of-use race.
  echo -n "As a Sandstorm user, you are invited to use a free Internet hostname "
  echo "as a subdomain of sandcats.io."

  sandcats_generate_keys

  # Having set up the keys, we run the function to register a name
  # with Sandcats. This function handles tail-recursing itself until
  # it succeeds and/or returning when the user expresses a desire to
  # cancel the process.
  sandcats_register_name
}

configure_hostnames() {
  if [ "yes" = "$USE_SANDCATS" ] ; then
    # If we're lucky, the user will be happy with the Sandcats
    # hostname configuration. If not, then we'll have to actually
    # prompt them.
    sandcats_configure
  fi

  # Ask the user for port number information. (These functions
  # optionally skip the questions if the details have already been
  # filled in.)
  choose_port
  choose_mongo_port

  # If we are supposed to use the external network interface, then
  # configure the hostname and IP address accordingly.
  if [ "yes" = "$USE_EXTERNAL_INTERFACE" ]; then
    BIND_IP=0.0.0.0
    SS_HOSTNAME="${SS_HOSTNAME:-$(hostname -f)}"
  else
    BIND_IP=127.0.0.1
    SS_HOSTNAME=local.sandstorm.io
    if [ "yes" != "$USE_DEFAULTS" ] ; then
      echo "Note: local.sandstorm.io maps to 127.0.0.1, i.e. your local machine."
      echo "For reasons that will become clear in the next step, you should use this"
      echo "instead of 'localhost'."
    fi
  fi

  DEFAULT_BASE_URL="http://$SS_HOSTNAME:$PORT"
  if [ "yes" = "$SANDCATS_SUCCESSFUL" ] ; then
    # Do not prompt for BASE_URL configuration if Sandcats bringup
    # succeeded.
    BASE_URL="$DEFAULT_BASE_URL"
  else
    BASE_URL=$(prompt "URL users will enter in browser:" "$DEFAULT_BASE_URL")
  fi

  # If the BASE_URL looks like localhost, then we had better use a
  # DEFAULT_WILDCARD of local.sandstorm.io so that wildcard DNS works.
  if [[ "$BASE_URL" =~ ^http://localhost(|:[0-9]*)(/.*)?$ ]]; then
    DEFAULT_WILDCARD=*.local.sandstorm.io${BASH_REMATCH[1]}
  elif [[ "$BASE_URL" =~ ^[^:/]*://(.*)$ ]]; then
    DEFAULT_WILDCARD="${DEFAULT_WILDCARD:-*.${BASH_REMATCH[1]}}"
  else
    DEFAULT_WILDCARD=
  fi

  # If we did the sandcats configuration, then we trust it to provide
  # a working WILDCARD_HOST.
  if [ "yes" = "$SANDCATS_SUCCESSFUL" ] ; then
    WILDCARD_HOST="$DEFAULT_WILDCARD"
  else
    if [ "yes" != "$USE_DEFAULTS" ] ; then
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
    fi
    WILDCARD_HOST=$(prompt "Wildcard host:" "$DEFAULT_WILDCARD")

    while ! [[ "$WILDCARD_HOST" =~ ^[^*]*[*][^*]*$ ]]; do
      error "Invalid wildcard host. It must contain exactly one asterisk."
      WILDCARD_HOST=$(prompt "Wildcard host:" "$DEFAULT_WILDCARD")
    done
  fi
}

choose_install_dir() {
  if [ -z "${DIR:-}" ] ; then
    local DEFAULT_DIR="$DEFAULT_DIR_FOR_ROOT"
    if [ "yes" != "$CURRENTLY_UID_ZERO" ] ; then
      DEFAULT_DIR="$DEFAULT_DIR_FOR_NON_ROOT"
    fi

    DIR=$(prompt "Where would you like to put Sandstorm?" "$DEFAULT_DIR")

    if [ -e "$DIR" ]; then
      echo "$DIR already exists. Sandstorm will assume ownership of all contents."
      prompt-yesno "Is this OK?" yes || fail
    fi
  fi

  mkdir -p "$DIR"
  cd "$DIR"
}

load_existing_settings() {
  # If there is no settings file to load, then we can skip the
  # rest of this function.
  if [ ! -e sandstorm.conf ]; then
    return
  fi

  echo "Found existing sandstorm.conf. Using it."
  . sandstorm.conf
  if [ "${SERVER_USER:+set}" != set ]; then
    fail "Existing config does not set SERVER_USER. Please fix or delete it."
  fi

  # If sandstorm.conf specifies an UPDATE_CHANNEL, then make that be
  # the default. Additionally, because UPDATE_CHANNEL is already
  # set, the part of the code that prompts the user about what
  # UPDATE_CHANNEL they want should skip itself.
  if [ "${UPDATE_CHANNEL:-none}" != none ]; then
    DEFAULT_UPDATE_CHANNEL=$UPDATE_CHANNEL
  fi
}

choose_server_user_if_needed() {
  # If there is already a sandstorm.conf, we assume that it has a
  # SERVER_USER set and that the user exists. This is a
  # basically-reasonable assumption, given that
  # load_existing_settings() verifies that there is a SERVER_USER set.
  if [ -e sandstorm.conf ] ; then
    return
  fi

  # If we are not root, then life is easy; we run Sandstorm as the current
  # user.
  if [ "yes" != "$CURRENTLY_UID_ZERO" ]; then
    SERVER_USER=$(id -un)
    return
  fi

  # If previous configuration (e.g. easy-configuration, option 1) requested a
  # specific SERVER_USER, then let's go with that.
  if [ ! -z "${DESIRED_SERVER_USER:-}" ] ; then
    SERVER_USER="$DESIRED_SERVER_USER"
    CREATE_SERVER_USER="0"  # sh for True
    ADD_SUDO_USER_TO_SERVER_GROUP="1"  # sh for False
    return
  fi

  # If we got this far, then we need to ask.
  SERVER_USER=$(prompt "Local user account to run server under:" sandstorm)

  while [ "$SERVER_USER" = root ]; do
    echo "Sandstorm cannot run as root!"
    SERVER_USER=$(prompt "Local user account to run server under:" sandstorm)
  done
}

create_server_user_if_needed() {
  # Find out if the user exists. If so, then we're done!
  if id "$SERVER_USER" > /dev/null 2>&1; then
    return
  fi

  # Since the server user does not exist, we create it (asking for
  # permission if necessary).
  if [ "0" != "${CREATE_SERVER_USER:-}" ] ; then
    prompt-yesno "User account '$SERVER_USER' doesn't exist. Create it?" yes
    CREATE_SERVER_USER="$?"
  fi

  # If people don't want us to create it, then let's bail now.
  if [ "0" != "$CREATE_SERVER_USER" ] ; then
    return
  fi

  # OK!
  useradd --system "$SERVER_USER"

  echo "Note: Sandstorm's storage will only be accessible to the group '$SERVER_USER'."

  # If SUDO_USER is non-empty, we let the user opt in to adding
  # themselves to the storage group.

  # The easy-install opts out of this flow by setting
  # ADD_SUDO_USER_TO_SERVER_GROUP=1.
  if [ "1" = "$ADD_SUDO_USER_TO_SERVER_GROUP" ] ; then
    return
  fi

  if [ -n "${SUDO_USER:-}" ]; then
    if prompt-yesno "Add user '$SUDO_USER' to group '$SERVER_USER'?" no ; then
      usermod -a -G "$SERVER_USER" "$SUDO_USER"
      echo "Added. Don't forget that group changes only apply at next login."
    fi
  fi
}

choose_port() {
  # If there already is a PORT chosen, then don't bother asking.
  if [ ! -z "${PORT:-}" ] ; then
    return
  fi


  PORT=$(prompt "Server main HTTP port:" $DEFAULT_PORT)

  while [ "$PORT" -lt 1024 ]; do
    echo "Ports below 1024 require root privileges. Sandstorm does not run as root."
    echo "To use port $PORT, you'll need to set up a reverse proxy like nginx that "
    echo "forwards to the internal higher-numbered port. The Sandstorm git repo "
    echo "contains an example nginx config for this."
    PORT=$(prompt "Server main HTTP port:" $DEFAULT_PORT)
  done
}

choose_mongo_port() {
  # If there is already a MONGO_PORT chosen, then don't bother asking.
  if [ ! -z "${MONGO_PORT:-}" ] ; then
    return
  fi

  MONGO_PORT=$(prompt "Database port (choose any unused port):" "$((PORT + 1))")
}

choose_external_or_internal() {
  # Figure out if we want to listen on internal vs. external interfaces.
  if [ "yes" != "$USE_EXTERNAL_INTERFACE" ]; then
    if prompt-yesno "Expose to localhost only?" yes ; then
      USE_EXTERNAL_INTERFACE="no"
    else
      USE_EXTERNAL_INTERFACE="yes"
    fi
  fi
}

configure_auto_updates() {
  # If UPDATE_CHANNEL is non-empty, then skip this.
  if [ -n "${UPDATE_CHANNEL:-}" ]; then
    return
  fi

  # Otherwise, ask!
  if prompt-yesno "Automatically keep Sandstorm updated?" yes; then
    UPDATE_CHANNEL=$DEFAULT_UPDATE_CHANNEL
  else
    UPDATE_CHANNEL=none
  fi
}

configure_dev_accounts() {
  # If ALLOW_DEV_ACCOUNTS is set to yes already, then skip this.
  if [ "yes" = "${ALLOW_DEV_ACCOUNTS}" ]; then
    return
  fi

  # If USE_EXTERNAL_INTERFACE is set to yes, then skip this, because
  # dev accounts on the Internet would be crazy.
  if [ "yes" = "${USE_EXTERNAL_INTERFACE}" ] ; then
    return
  fi

  echo "Sandstorm supports 'dev accounts', a feature that lets anyone log in"
  echo "as admin and other sample users to a Sandstorm server. We recommend"
  echo "it for app development, and absolutely do not recommend it for"
  echo "a server on the public Internet."

  if prompt-yesno "Enable dev accounts?" "yes" ; then
    ALLOW_DEV_ACCOUNTS=yes
  fi
}

save_config() {
  writeConfig SERVER_USER PORT MONGO_PORT BIND_IP BASE_URL WILDCARD_HOST UPDATE_CHANNEL ALLOW_DEV_ACCOUNTS > sandstorm.conf
  if [ "yes" = "$SANDCATS_SUCCESSFUL" ] ; then
    writeConfig SANDCATS_BASE_DOMAIN >> sandstorm.conf
  fi

  echo
  echo "Config written to $PWD/sandstorm.conf."
}

download_latest_bundle_and_extract_if_needed() {
  # If BUNDLE_FILE is non-empty, we were provided a bundle file, so we
  # can skip downloading one.
  if [ -n "${BUNDLE_FILE:-}" ]; then
    return
  fi

  echo "Finding latest build for $DEFAULT_UPDATE_CHANNEL channel..."
  BUILD=$(curl -fs "https://install.sandstorm.io/$DEFAULT_UPDATE_CHANNEL?from=0&type=install")
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
}

extract_bundle_if_provided() {
  # If BUNDLE_FILE is empty, it means that we have no bundle file to extract,
  # so we can skip downloading it.
  if [ -z "${BUNDLE_FILE:-}" ]; then
    return
  fi

  # Use the specified local bundle, which we already validated earlier.

  if [ $BUILD = 0 ]; then
    BUILD_DIR=sandstorm-custom.$(date +'%Y-%m-%d_%H-%M-%S')
  else
    BUILD_DIR=sandstorm-$BUILD
  fi

  rm -rf "$BUILD_DIR"
  mkdir "$BUILD_DIR"
  (cd "$BUILD_DIR" && tar Jxof "$BUNDLE_FILE" --strip=1)
}

make_runtime_directories() {
  GROUP=$(id -g $SERVER_USER)

  # Make var directories.
  mkdir -p var/{log,pid,mongo} var/sandstorm/{apps,grains,downloads}

  # Create useful symlinks.
  ln -sfT $BUILD_DIR latest
  ln -sfT latest/sandstorm sandstorm
}

set_permissions() {
  # If not running the installer as root, we can't do all the
  # permissions stuff we want to.
  if [ "yes" != "$CURRENTLY_UID_ZERO" ]; then
    return
  fi

  # Set ownership of files.  We want the dirs to be root:sandstorm but the contents to be
  # sandstorm:sandstorm.
  chown -R $SERVER_USER:$GROUP var/{log,pid,mongo} var/sandstorm/{apps,grains,downloads}
  chown root:$GROUP var/{log,pid,mongo} var/sandstorm/{apps,grains,downloads}
  chmod -R g=rwX,o= var/{log,pid,mongo} var/sandstorm/{apps,grains,downloads}

  # Don't allow listing grain IDs directly.  (At the moment, this is faux security since
  # an attacker could just read the database, but maybe that will change someday...)
  chmod g-r var/sandstorm/grains
}

install_sandstorm_symlinks() {
  # If not running the installer as root, we can't modify
  # /usr/local/bin, so we have to skip this.
  if [ "yes" != "$CURRENTLY_UID_ZERO" ]; then
    return
  fi

  # Install tools.
  ln -sfT $PWD/sandstorm /usr/local/bin/sandstorm
  ./sandstorm devtools
}

ask_about_starting_at_boot() {
  # If we already know we want to start the thing at boot, we can
  # skip asking.
  if [ "yes" = "${START_AT_BOOT:-}" ] ; then
    return
  fi

  if prompt-yesno "Start sandstorm at system boot (using $INIT_SYSTEM)?" yes; then
    START_AT_BOOT=yes
  fi
}

configure_start_at_boot_if_desired() {
  SANDSTORM_NEEDS_TO_BE_STARTED="yes"

  # If the user doesn't want us to start Sandstorm at boot, then we
  # don't run anything in this function.
  if [ "yes" != "${START_AT_BOOT:-}" ] ; then
    return
  fi

  # Also, if we are not running as root, we do not bother with these
  # steps.
  if [ "yes" != "${CURRENTLY_UID_ZERO}" ] ; then
    return
  fi

  if [ "systemd" = "${INIT_SYSTEM}" ] ; then
    configure_systemd_init_system
    SANDSTORM_NEEDS_TO_BE_STARTED=no
  elif [ "sysvinit" = "${INIT_SYSTEM}" ] ; then
    configure_sysvinit_init_system
    SANDSTORM_NEEDS_TO_BE_STARTED=no
  else
    echo "Note: I don't know how to set up sandstorm to auto-run at startup on"
    echo "  your system. :("
    echo
  fi
}

configure_systemd_init_system() {
  # WARNING: This function should only be run if we already know
  # systemd is the current init system. It relies on its caller to
  # verify that.

  local SYSTEMD_UNIT="sandstorm.service"

  # Stop Sandstorm if it is currently running.
  if systemctl list-unit-files | grep -q $SYSTEMD_UNIT; then
    systemctl stop sandstorm || true
  fi

  # the init.d logic simply overwrites the init script if it exists, adopt that here
  for SYSTEMD_UNIT_PATH in /etc/systemd/system /run/systemd/system /usr/lib/systemd/system; do
    if [ -e $SYSTEMD_UNIT_PATH/$SYSTEMD_UNIT ] ; then
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
}

configure_sysvinit_init_system() {
  # WARNING: This function should only be run if we already know
  # sysvinit is the current init system. It relies on its caller to
  # verify that.

  # Stop Sandstorm, since we don't know what its configuration is.
  if [ -e /etc/init.d/sandstorm ] ; then
    service sandstorm stop || true
  fi

  # Replace the init script with something that should definitely
  # work.

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

  # Mark as executable, and enable on boot.
  chmod +x /etc/init.d/sandstorm
  update-rc.d sandstorm defaults

  # Start it right now.
  service sandstorm start
}

print_success() {
  if [ "yes" = "$SANDSTORM_NEEDS_TO_BE_STARTED" ] ; then
    echo "Setup complete. To start your server now, run:"
    echo "  $DIR/sandstorm start"
    echo "It will then run at:"
  else
    echo "Setup complete. Your server should be running at:"
  fi
  echo "  ${BASE_URL:-(unknown; bad config)}"
  echo "To learn how to control the server, run:"
  if [ "yes" = "$CURRENTLY_UID_ZERO" ] ; then
    echo "  sandstorm help"
  else
    echo "  $DIR/sandstorm help"
  fi
}

sandcats_register_name() {
  # We allow environment variables to override some details of the
  # Sandcats service, so that during development, we can test against
  # a non-production Sandcats service.
  SANDCATS_API_BASE="${OVERRIDE_SANDCATS_API_BASE:-https://sandcats.io}"
  SANDCATS_CURL_PARAMS="${OVERRIDE_SANDCATS_CURL_PARAMS:-}"

  echo "Choose your desired Sandcats subdomain (alphanumeric, max 20 characters)."
  echo "Type the word none to skip this step."
  DESIRED_SANDCATS_NAME=$(prompt "What *.${SANDCATS_BASE_DOMAIN} subdomain would you like?" '')

  # If they just press enter, insist that they type either the word
  # "none" or provide a name they want to register.
  if [ -z "$DESIRED_SANDCATS_NAME" ] ; then
    sancats_register_name
    return
  fi

  # If the user really wants none of our sandcats help, then bail out.
  if [ "none" = "$DESIRED_SANDCATS_NAME" ] ; then
    return
  fi

  # Validate the client-side, to avoid problems, against the same
  # regex that the server is using.
  if ! [[ $DESIRED_SANDCATS_NAME =~ ^[0-9a-zA-Z]{1,20}$ ]] ; then
    sandcats_register_name
    return
  fi

  # Ask them for their email address, since we use that as part of Sandcats
  # registration.
  echo "We need your email on file so we can help you recover your domain if you lose access. No spam."
  SANDCATS_REGISTRATION_EMAIL=$(prompt "Enter your email address:" "")

  # If the user fails to enter an email address, bail out.
  while [ "" = "$SANDCATS_REGISTRATION_EMAIL" ] ; do
    echo "For the DNS service, we really do need an email address. To cancel, type: Ctrl-C."
    SANDCATS_REGISTRATION_EMAIL=$(prompt "Enter your email address:" "")
  done

  echo "Registering..."
  HTTP_STATUS=$(
    curl \
      --silent \
      --max-time 20 \
      $SANDCATS_CURL_PARAMS \
      -X POST \
      --data-urlencode "rawHostname=$DESIRED_SANDCATS_NAME" \
      --data-urlencode "email=$SANDCATS_REGISTRATION_EMAIL" \
      --output var/sandcats/register-log \
      -w '%{http_code}' \
      -H 'X-Sand: cats' \
      -H "Accept: text/plain" \
      --cert var/sandcats/id_rsa.private_combined \
      "${SANDCATS_API_BASE}/register")

  if [ "200" = "$HTTP_STATUS" ]
  then
    # Show the server's output, which presumably is some happy
    # message.
    cat var/sandcats/register-log
    # Make sure that is on a line of its own.
    echo ''
    # Set these global variables to inform the installer down the
    # road.
    SS_HOSTNAME="${DESIRED_SANDCATS_NAME}.${SANDCATS_BASE_DOMAIN}"
    USE_EXTERNAL_INTERFACE="yes"
    SANDCATS_SUCCESSFUL="yes"
    echo "Congratulations! We have registered your ${DESIRED_SANDCATS_NAME}.${SANDCATS_BASE_DOMAIN} name."
    echo "Your credentials to use it are in $(readlink -f var/sandcats); consider making a backup."
  else
    # Show the server's output, and re-run this function.
    error "$(cat var/sandcats/register-log)"
    sandcats_register_name
    return
  fi
}

sandcats_generate_keys() {
    # The Sandcats service places its authentication files in $DIR/var/sandcats.
    if [ -f var/sandcats/id_rsa.private_combined ] ; then
        return
    fi

    # The openssl key generation process can take a few seconds, so we
    # print a ... while that happens.
    echo -n '...'

    # We are already in $DIR. It's important to make it mode 0700
    # because we store TLS client authentication keys here.
    mkdir -p -m 0700 var/sandcats
    chmod 0700 var/sandcats

    # Generate key for client certificate. OpenSSL will read from
    # /dev/urandom by default, so this won't block. We abuse the ``
    # operator so we can have inline comments in a multi-line command.
    openssl \
        req `# Invoke OpenSSL's PKCS#10 X.509 bits.` \
        -new `# Create a new certificate/request.` \
        -newkey rsa:4096 `# Create a new RSA key of length 4096 bits.` \
        -days 3650 `# Make the self-signed cert valid for 10 years.` \
        -nodes `# no DES -- that is, do not encrypt the key at rest.` \
        -x509 `# Output a certificate, rather than a signing request.` \
        `# Sandcats ignores the subject in the certificate; use` \
        `# OpenSSL defaults.` \
        -subj "/C=AU/ST=Some-State/O=Internet Widgits Pty Ltd" \
        -keyout var/sandcats/id_rsa `# Store the resulting RSA private key in id_rsa` \
        -out var/sandcats/id_rsa.pub `# Store the resulting certificate in id_rsa.pub` \
        2>/dev/null `# Silence the progress output.`

    # We combine these two things into one glorious all-inclusive file
    # for the `curl` command. It is just as private as id_rsa.
    cat var/sandcats/id_rsa var/sandcats/id_rsa.pub > var/sandcats/id_rsa.private_combined

    # Set filesystem permissions, in case the files get copied
    # into the wrong place later.
    chmod 0600 var/sandcats/id_rsa var/sandcats/id_rsa.pub var/sandcats/id_rsa.private_combined

    # Go to the start of the line, before the "..." that we
    # left on the screen, allowing future echo statements to
    # overwrite it.
    echo -ne '\r'
}

# Now that the steps exist as functions, run them in an order that
# would result in a working install.
detect_current_uid
handle_args "$@"
assert_on_terminal
assert_linux_x86_64
assert_usable_kernel
assert_userns_clone
assert_dependencies
assert_valid_bundle_file
detect_init_system
choose_install_mode
choose_external_or_internal
choose_install_dir
load_existing_settings
choose_server_user_if_needed
create_server_user_if_needed
configure_auto_updates
configure_dev_accounts
configure_hostnames
save_config
download_latest_bundle_and_extract_if_needed
extract_bundle_if_provided
make_runtime_directories
set_permissions
install_sandstorm_symlinks
ask_about_starting_at_boot
configure_start_at_boot_if_desired
print_success
}

# Now that we know the whole script has downloaded, run it.
_ "$0" "$@"

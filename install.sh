#! /bin/bash

# This script installs the Sandstorm Personal Cloud Server on your Linux
# machine. You can run the latest installer directly from the web by doing:
#
#     curl https://install.sandstorm.io | bash
#
# If `curl|bash` makes you uncomfortable, see other options here:
#
#     https://docs.sandstorm.io/en/latest/install/
#
# This script only modifies your system in the following ways:
# - Install Sandstorm into the directory you choose, typically /opt/sandstorm.
# - Optionally add an initscript or systemd service:
#     /etc/init.d/sandstorm
#     /etc/systemd/system/sandstorm.service
# - Add commands "sandstorm" and "spk" to /usr/local/bin.
#
# Once installed, you may uninstall with the command: sandstorm uninstall
#
# The script will ask you whether you're OK with giving it root privileges.
# If you refuse, the script can still install Sandstorm (to a directory you
# own), but will not be able to install the initscript or shortcut commands,
# and the dev tools will not work (due to limitations with using FUSE in a
# sandbox).
#
# This script downloads and installs binaries. This means that to use this
# script, you need to trust that the authors are not evil, or you must use
# an isolated machine or VM. Of course, since the Sandstorm authors'
# identities are widely known, if they did try to do anything evil, you
# could easily get them arrested. That said, if you'd rather install from
# 100% auditable source code, please check out the Github repository instead.
#
# All downloads occur over HTTPS from Sandstorm's servers and are further
# verified using PGP.

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

# Allow the environment to override curl's User-Agent parameter. We
# use this to distinguish probably-actual-users installing Sandstorm
# from the automated test suite, which invokes the install script with
# this environment variable set.
CURL_USER_AGENT="${CURL_USER_AGENT:-sandstorm-install-script}"

# Define I/O helper functions.
error() {
  if [ $# != 0 ]; then
    echo -en '\e[0;31m' >&2
    echo "$@" | (fold -s || cat) >&2
    echo -en '\e[0m' >&2
  fi
}

fail() {
  local error_code="$1"
  shift
  if [ "${SHOW_FAILURE_MSG:-yes}" = "yes" ] ; then
    echo "*** INSTALLATION FAILED ***" >&2
    echo ""
  fi
  error "$@"
  echo "" >&2

  if [ "$error_code" = E_CURL_MISSING ] ; then
    # There's no point in asking the user if they want to report an issue, since
    # (1) there isn't one, they just need to install curl, and (2) doing so will
    # fail anyway, since we use curl to send the report. We've already displayed
    # the error, so just exit now.
    exit 1
  fi

  # Users can export REPORT=no to avoid the error-reporting behavior, if they need to.
  if [ "${REPORT:-yes}" = "yes" ] ; then
    if USE_DEFAULTS=no prompt-yesno "Hmm, installation failed. Would it be OK to send an anonymous error report to the sandstorm.io team so we know something is wrong?
It would only contain this error code: $error_code" "yes" ; then
      echo "Sending problem report..." >&2
      local BEARER_TOKEN="ZiV1jbwHBPfpIjF3LNFv9-glp53F7KcsvVvljgKxQAL"
      local API_ENDPOINT="https://api.oasis.sandstorm.io/api"
      local HTTP_STATUS=$(
        dotdotdot_curl \
          --silent \
          --max-time 20 \
          --data-binary "{\"error_code\":\"$error_code\",\"user-agent\":\"$CURL_USER_AGENT\"}" \
          -H "Authorization: Bearer $BEARER_TOKEN" \
          -X POST \
          --output "/dev/null" \
          -w '%{http_code}' \
          "$API_ENDPOINT")
      if [ "200" == "$HTTP_STATUS" ] ; then
        echo "... problem reported successfully. Your installation did not succeed." >&2
      elif [ "000" == "$HTTP_STATUS" ] ; then
        error "Submitting error report failed. Maybe there is a connectivity problem."
      else
        error "Submitting error report resulted in strange HTTP status: $HTTP_STATUS"
      fi
    else
      echo "Not sending report." >&2
    fi
    echo ""
  fi
  echo "You can report bugs at: http://github.com/sandstorm-io/sandstorm" >&2
  exit 1
}

retryable_curl() {
  # This function calls curl to download a file. If the file download fails, it asks the user if it
  # is OK to retry.
  local CURL_FAILED="no"
  curl -A "${CURL_USER_AGENT}" -f "$1" > "$2" || CURL_FAILED="yes"
  if [ "yes" = "${CURL_FAILED}" ] ; then
    if prompt-yesno "Downloading $1 failed. OK to retry?" "yes" ; then
      echo "" >&2
      echo "Download failed. Waiting one second before retrying..." >&2
      sleep 1
      retryable_curl "$1" "$2"
    fi
  fi
}

dotdotdot_curl() {
  # This function calls curl, but first prints "..." to the screen, in
  # an attempt to indicate to the user that the script is waiting on
  # something.
  #
  # It then moves the cursor to the start of the line, so that future
  # echo-ing will overwrite those dots.
  #
  # Since the script is -e, and in general we don't have a reliable
  # thing that we do in the case that curl exits with a non-zero
  # status code, we don't capture the status code; we allow the script
  # to abort if curl exits with a non-zero status.

  # Functions calling dotdotdot_curl expect to capture curl's own
  # stdout. Therefore we do our echo-ing to stderr.

  echo -n '...' >&2

  curl "$@"

  echo -ne '\r' >&2
}

is_port_bound() {
  local SCAN_HOST="$1"
  local SCAN_PORT="$2"

  if [ "${DEV_TCP_USABLE}" = "unchecked" ] ; then
    REPORT=no fail "E_DEV_TCP_UNCHECKED" "Programmer error. The author of install.sh used an uninitialized variable."
  fi

  # We also use timeout(1) from coreutils to avoid this process taking a very long
  # time in the case of e.g. weird network rules or something.
  if [ "${DEV_TCP_USABLE}" = "yes" ] ; then
    if timeout 1 bash -c ": < /dev/tcp/${SCAN_HOST}/${SCAN_PORT}" 2>/dev/null; then
      return 0
    else
      return 1
    fi
  fi

  # If we are using a traditional netcat, then -z (zero i/o mode)
  # works for scanning-type uses. (Debian defaults to this.)
  #
  # If we are using the netcat from the nmap package, then we can use
  # --recv-only --send-only to get the same behavior. (Fedora defaults
  # to this.)
  #
  # nc will either:
  #
  # - return true (exit 0) if it connected to the port, or
  #
  # - return false (exit 1) if it failed to connect to the port, or
  #
  # - return false (exit 1) if we are passing it the wrong flags.
  #
  # So if either if these invocations returns true, then we know the
  # port is bound.
  local DEBIAN_STYLE_INDICATED_BOUND="no"
  ${NC_PATH} -z "$SCAN_HOST" "$SCAN_PORT" >/dev/null 2>/dev/null && DEBIAN_STYLE_INDICATED_BOUND=yes

  if [ "$DEBIAN_STYLE_INDICATED_BOUND" == "yes" ] ; then
      return 0
  fi

  # Not sure yet. Let's try the nmap-style way.
  local NMAP_STYLE_INDICATED_BOUND="no"
  ${NC_PATH} --wait 1 --recv-only --send-only "$SCAN_HOST" "$SCAN_PORT" >/dev/null 2>/dev/null && \
      NMAP_STYLE_INDICATED_BOUND=yes

  if [ "$NMAP_STYLE_INDICATED_BOUND" == "yes" ] ; then
      return 0
  fi

  # As far as we can tell, nmap can't connect to the port, so return 1
  # to indicate it is not bound.
  return 1
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

  # We use "bold", rather than any particular color, to maximize readability. See #2037.
  echo -en '\e[1m' >&3
  echo -n "$1 [$2]" >&3
  echo -en '\e[0m ' >&3
  read -u 3 VALUE
  if [ -z "$VALUE" ]; then
    VALUE=$2
  fi
  echo "$VALUE"
}

prompt-numeric() {
  local NUMERIC_REGEX="^[0-9]+$"
  while true; do
    local VALUE=$(prompt "$@")

    if ! [[ "$VALUE" =~ $NUMERIC_REGEX ]] ; then
      echo "You entered '$VALUE'. Please enter a number." >&3
    else
      echo "$VALUE"
      return
    fi
  done
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
USE_HTTPS="no"
CURRENTLY_UID_ZERO="no"
PREFER_ROOT="yes"
SHOW_MESSAGE_ABOUT_NEEDING_PORTS_OPEN="no"
STARTED_SANDSTORM="no"

# Allow the test suite to override the path to netcat in order to
# reproduce a compatibility issue between different nc versions.
NC_PATH="${OVERRIDE_NC_PATH:-nc}"

# Allow install.sh to store if bash /dev/tcp works.
DEV_TCP_USABLE="unchecked"

# Defaults for some config options, so that if the user requests no
# prompting, they get these values.
DEFAULT_DIR_FOR_ROOT="${OVERRIDE_SANDSTORM_DEFAULT_DIR:-/opt/sandstorm}"
DEFAULT_DIR_FOR_NON_ROOT="${OVERRIDE_SANDSTORM_DEFAULT_DIR:-${HOME:-opt}/sandstorm}"
DEFAULT_SMTP_PORT="30025"
DEFAULT_UPDATE_CHANNEL="dev"
DEFAULT_SERVER_USER="${OVERRIDE_SANDSTORM_DEFAULT_SERVER_USER:-sandstorm}"
SANDCATS_BASE_DOMAIN="${OVERRIDE_SANDCATS_BASE_DOMAIN:-sandcats.io}"
ALLOW_DEV_ACCOUNTS="false"
SANDCATS_GETCERTIFICATE="${OVERRIDE_SANDCATS_GETCERTIFICATE:-yes}"

# Define functions for each stage of the install process.

usage() {
  echo "usage: $SCRIPT_NAME [-d] [-e] [-p PORT_NUMBER] [-u] [<bundle>]" >&2
  echo "If <bundle> is provided, it must be the name of a Sandstorm bundle file," >&2
  echo "like 'sandstorm-123.tar.xz', which will be installed. Otherwise, the script" >&2
  echo "downloads a bundle from the internet via HTTPS." >&2
  echo '' >&2
  echo 'If -d is specified, the auto-installs with defaults suitable for app development.' >&2
  echo 'If -e is specified, default to listening on an external interface, not merely loopback.' >&2
  echo 'If -i is specified, default to (i)nsecure mode where we do not request a HTTPS certificate.' >&2
  echo 'If -p is specified, use its argument (PORT_NUMBER) as the default port for HTTP. Otherwise, use 6080. Note that if the install script enables HTTPS, it will use 443 instead!'
  echo 'If -u is specified, default to avoiding root priviliges. Note that the dev tools only work if the server has root privileges.' >&2
  exit 1
}

detect_current_uid() {
  if [ $(id -u) = 0 ]; then
    CURRENTLY_UID_ZERO="yes"
  fi
}

disable_smtp_port_25_if_port_unavailable() {
  PORT_25_AVAILABLE="no"
  if is_port_bound 0.0.0.0 25; then
    return
  fi
  if is_port_bound 127.0.0.1 25; then
    return
  fi
  PORT_25_AVAILABLE="yes"
}

disable_https_if_ports_unavailable() {
  # If port 80 and 443 are both available, then let's use DEFAULT_PORT=80. This value is what the
  # Sandstorm installer will write to PORT= in the Sandstorm configuration file.
  #
  # If either 80 or 443 is not available, then we set SANDCATS_GETCERTIFICATE to no.
  #
  # From the rest of the installer's perspective, if SANDCATS_GETCERTIFICATE is yes, it is safe to
  # bind to port 443.
  #
  # There is a theoretical race condition here. I think that's life.
  #
  # This also means that if a user has port 443 taken but port 80 available, we will use port 6080
  # as the default port. If the user wants to override that, they can run install.sh with "-p 80".
  local PORT_80_AVAILABLE="no"
  is_port_bound 0.0.0.0 80 || PORT_80_AVAILABLE="yes"

  local PORT_443_AVAILABLE="no"
  is_port_bound 0.0.0.0 443 || PORT_443_AVAILABLE="yes"

  if [ "$PORT_443_AVAILABLE" == "no" -o "$PORT_80_AVAILABLE" == "no" ] ; then
    SANDCATS_GETCERTIFICATE="no"
    SHOW_MESSAGE_ABOUT_NEEDING_PORTS_OPEN="yes"
  fi
}


handle_args() {
  SCRIPT_NAME=$1
  shift

  while getopts ":deiup:" opt; do
    case $opt in
      d)
        USE_DEFAULTS="yes"
        ;;
      e)
        USE_EXTERNAL_INTERFACE="yes"
        ;;
      i)
        SANDCATS_GETCERTIFICATE="no"
        ;;
      u)
        PREFER_ROOT=no
        ;;
      p)
        DEFAULT_PORT="${OPTARG}"
        ;;
      *)
        usage
        ;;
    esac
  done

  # If DEFAULT_PORT didn't get set above, set it to 6080 here.
  DEFAULT_PORT="${DEFAULT_PORT:-6080}"

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

  # Remove newlines in $@, otherwise when we try to use $@ in a string passed
  # to 'bash -c' the command gets cut off at the newline. ($@ contains newlines
  # because at the call site we used escaped newlines for readability.)
  local ENVVARS=$(echo $@)

  # Add CURL_USER_AGENT to ENVVARS, since we always need to pass this
  # through.
  ENVVARS="$ENVVARS CURL_USER_AGENT=$CURL_USER_AGENT"

  if [ "$(basename $SCRIPT_NAME)" == bash ]; then
    # Probably ran like "curl https://sandstorm.io/install.sh | bash"
    echo "Re-running script as root..."

    exec sudo bash -euo pipefail -c "curl -fs -A $CURL_USER_AGENT https://install.sandstorm.io | $ENVVARS bash"
  elif [ "$(basename $SCRIPT_NAME)" == install.sh ] && [ -e "$0" ]; then
    # Probably ran like "bash install.sh" or "./install.sh".
    echo "Re-running script as root..."
    if [ ${#ORIGINAL_ARGS[@]} = 0 ]; then
      exec sudo $ENVVARS bash "$SCRIPT_NAME"
    else
      exec sudo $ENVVARS bash "$SCRIPT_NAME" "${ORIGINAL_ARGS[@]}"
    fi
  fi

  # Don't know how to run the script. Let the user figure it out.
  REPORT=no fail "E_CANT_SWITCH_TO_ROOT" "ERROR: This script could not detect its own filename, so could not switch to root. \
Please download a copy and name it 'install.sh' and run that as root, perhaps using sudo. \
Try this command:

curl https://install.sandstorm.io/ > install.sh && sudo bash install.sh"
}

set_umask() {
  # Use umask 0022, to minimize how much 'mkdir -m' we have to do, etc. See #2300.
  umask 0022
}

assert_on_terminal() {
  if [ "no" = "$USE_DEFAULTS" ] && [ ! -t 1 ]; then
    REPORT=no fail "E_NO_TTY" "This script is interactive. Please run it on a terminal."
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
    fail "E_NON_LINUX" "Sandstorm requires Linux. If you want to run Sandstorm on a Windows or
Mac system, you can use Vagrant or another virtualization tool. See our install documentation:

- https://docs.sandstorm.io/en/latest/install/"
  fi

  if [ "$(uname -m)" != x86_64 ]; then
    fail "E_NON_X86_64" "Sorry, the Sandstorm server currently only runs on x86_64 machines."
  fi
}

assert_usable_kernel() {
  KVERSION=( $(uname -r | grep -o '^[0-9.]*' | tr . ' ') )

  if (( KVERSION[0] < 3 || (KVERSION[0] == 3 && KVERSION[1] < 10) )); then
    error "Detected Linux kernel version: $(uname -r)"
    fail "E_KERNEL_OLDER_THAN_310" "Sorry, your kernel is too old to run Sandstorm. We require kernel" \
         "version 3.10 or newer."
  fi
}

maybe_enable_userns_sysctl() {
  # This function enables the Debian/Ubuntu-specific unprivileged
  # userns sysctl, if the system has it and we want it.

  if [ "$USE_DEFAULTS" != "yes" ] ; then
    # Only do this when -d is passed. -d means "use defaults suitable for app development", and
    # we want userns enabled for app development if possible since it enables UID randomization
    # which helps catch app bugs. For the rest of the world, we're fine using the privileged
    # sandbox instead.
    return
  fi

  if [ "no" = "$CURRENTLY_UID_ZERO" ] ; then
    # Not root. Can't do anything about it.
    return
  fi

  if [ ! -e /proc/sys/kernel/unprivileged_userns_clone ]; then
    # No such sysctl on this system.
    return
  fi

  local OLD_VALUE="$(< /proc/sys/kernel/unprivileged_userns_clone)"

  if [ "$OLD_VALUE" = "1" ]; then
    # Already enabled.
    return
  fi

  # Enable it.
  if sysctl -wq kernel.unprivileged_userns_clone=1 2>/dev/null; then
    echo "NOTE: Enabled unprivileged user namespaces because you passed -d."
  else
    # Apparently we can't. Maybe we're in a Docker container. Give up and use privileged sandbox.
    return
  fi

  # Also make sure it is re-enabled on boot. If sysctl.d exists, we drop our own config in there.
  # Otherwise we edit sysctl.conf, but that's less polite.
  local SYSCTL_FILENAME="/etc/sysctl.conf"
  if [ -d /etc/sysctl.d ] ; then
    SYSCTL_FILENAME="/etc/sysctl.d/50-sandstorm.conf"
  fi

  if ! cat >> "$SYSCTL_FILENAME" << __EOF__

# Enable non-root users to create sandboxes (needed by Sandstorm).
kernel.unprivileged_userns_clone = 1
__EOF__
  then
    # We couldn't make the change permanent, so undo the change. Probably everything will work
    # fine with the privileged sandbox. But if it doesn't, it's better that things fail now rather
    # than wait for a reboot.
    echo "NOTE: Never mind, not enabling userns because can't write /etc/sysctl.d."
    sysctl -wq "kernel.unprivileged_userns_clone=$OLD_VALUE" || true
    return
  fi
}

test_if_dev_tcp_works() {
  # In is_port_bound(), we prefer to use bash /dev/tcp to check if the port is bound. This is
  # available on most Linux distributions, but it is a compile-time flag for bash and at least
  # Debian historically disabled it.
  #
  # To test availability, we connect to localhost port 0, which is never available, hoping for a
  # TCP-related error message from bash. We use a subshell here because we don't care that timeout
  # will return false; we care if the grep returns false.
  if (timeout 1 bash -c ': < /dev/tcp/localhost/0' 2>&1 || true) | grep -q 'connect:' ; then
    # Good! bash should get "Connection refused" on this, and this message is prefixed
    # by the syscall it was trying to do, so therefore it tried to connect!
    DEV_TCP_USABLE="yes"
  else
    DEV_TCP_USABLE="no"
  fi
}

assert_dependencies() {
  if [ -z "${BUNDLE_FILE:-}" ]; then
    which curl > /dev/null|| fail "E_CURL_MISSING" "Please install curl(1). Sandstorm uses it to download updates."
  fi

  # To find out if port 80 and 443 are available, we need a working bash /dev/net or `nc` on
  # the path.
  if [ "${DEV_TCP_USABLE}" = "unchecked" ] ; then
    test_if_dev_tcp_works
  fi
  if [ "${DEV_TCP_USABLE}" = "no" ] ; then
    which nc > /dev/null || fail "E_NC_MISSING" "Please install nc(1). (Package may be called 'netcat-traditional' or 'netcat-openbsd'.)"
  fi

  which tar > /dev/null || fail "E_TAR_MISSING" "Please install tar(1)."
  which xz > /dev/null || fail "E_XZ_MISSING" "Please install xz(1). (Package may be called 'xz-utils'.)"
}

assert_valid_bundle_file() {
  # ========================================================================================
  # Validate bundle file, if provided

  if [ -n "${BUNDLE_FILE:-}" ]; then
    # Read the first filename out of the bundle, which should be the root directory name.
    # We use "|| true" here because tar is going to SIGPIPE when `head` exits.
    BUNDLE_DIR=$( (tar Jtf "$BUNDLE_FILE" || true) | head -n 1)
    if [[ ! "$BUNDLE_DIR" =~ sandstorm-([0-9]+)/ ]]; then
      fail "E_INVALID_BUNDLE" "$BUNDLE_FILE: Not a valid Sandstorm bundle"
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
  echo -n 'Sandstorm makes it easy to run web apps on your own server. '

  if [ "yes" = "$USE_DEFAULTS" ] ; then
    CHOSEN_INSTALL_MODE="${CHOSEN_INSTALL_MODE:-2}"  # dev server mode by default
  fi

  if [ "no" = "${PREFER_ROOT:-}" ] ; then
    echo ""
    echo "NOTE: Showing you all options, including development options, but omitting "
    echo "      init script automation, because you chose to install without using root."
    CHOSEN_INSTALL_MODE="${CHOSEN_INSTALL_MODE:-2}"  # dev server mode by default
  fi

  if [ -z "${CHOSEN_INSTALL_MODE:-}" ]; then
    echo "You can have:"
    echo ""
    echo "1. A typical install, to use Sandstorm (press enter to accept this default)"
    echo "2. A development server, for working on Sandstorm itself or localhost-based app development"
    echo ""
    CHOSEN_INSTALL_MODE=$(prompt-numeric "How are you going to use this Sandstorm install?" "1")
  fi

  if [ "1" = "$CHOSEN_INSTALL_MODE" ] ; then
    assert_full_server_dependencies
    full_server_install
  else
    dev_server_install
  fi
}

assert_full_server_dependencies() {
  # To set up sandcats, we need `openssl` on the path. Check for that,
  # and if it is missing, bail out and tell the user they have to
  # install it.
  which openssl > /dev/null|| fail "E_OPENSSL_MISSING" "Please install openssl(1). Sandstorm uses it for the Sandcats.io dynamic DNS service."
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

    echo "To set up Sandstorm, we will use sudo to switch to root, then"
    echo "provide further information before doing the install."
    echo "Sandstorm's database and web interface won't run as root."

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
      SHOW_FAILURE_MSG=no REPORT=no fail "E_NEED_ROOT" "
One development feature does require root. To install anyway, run:

install.sh -u

to install without using root access. In that case, Sandstorm will operate OK but package tracing ('spk dev') will not work."
    fi
  fi

  # If they did not pass -d, then let them opt into that, but only if
  # PREFER_ROOT is still enabled.
  #
  # If they pass -u without -d, then they can answer the questions one
  # by one.
  if [ "yes" != "$USE_DEFAULTS" ] && [ "yes" = "$PREFER_ROOT" ] ; then
    echo "We're going to:"
    echo ""
    echo "* Install Sandstorm in ${DEFAULT_DIR_FOR_ROOT}."
    echo "* Automatically keep Sandstorm up-to-date (with signed updates)."
    echo "* Create a service user ($DEFAULT_SERVER_USER) that owns Sandstorm's files."
    if [ -n "${SUDO_USER:-}" ]; then
      echo "* Add you ($SUDO_USER) to the $DEFAULT_SERVER_USER group so you can read/write app data."
    fi
    echo "* Expose the service only on localhost aka local.sandstorm.io, not the public Internet."
    echo "* Enable 'dev accounts', for easy developer login."
    if [ "unknown" == "$INIT_SYSTEM" ]; then
      echo "*** WARNING: Could not detect how to run Sandstorm at startup on your system. ***"
    else
        echo "* Configure Sandstorm to start on system boot (with $INIT_SYSTEM)."
    fi
    echo "* Listen for inbound email on port ${DEFAULT_SMTP_PORT}."
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

    # Bind to localhost, unless -e specified in argv.
    USE_EXTERNAL_INTERFACE="${USE_EXTERNAL_INTERFACE:-no}"

    # Use local.sandstorm.io as hostname unless environment variable declared otherwise. This
    # short-circuits the code elsewhere that uses the system hostname if USE_EXTERNAL_INTERFACE is
    # "yes".
    SS_HOSTNAME="${SS_HOSTNAME:-local.sandstorm.io}"

    # Use 30025 as the default SMTP_LISTEN_PORT.
    SMTP_LISTEN_PORT="${DEFAULT_SMTP_PORT}"

    # Start the service at boot, if we can.
    START_AT_BOOT="yes"

    # Do not ask questions about our dynamic DNS service.
    USE_SANDCATS="no"

    # Reasonable default ports.
    PORT="${DEFAULT_PORT}"

    # Allow the mongo prompting part to determine a reasonable MONGO_PORT.

    # Use the ALLOW_DEV_ACCOUNTS feature, which allows people to log
    # into a Sandstorm instance without setting up any accounts.
    ALLOW_DEV_ACCOUNTS="yes"

    # Do not bother setting a DESIRED_SERVER_USER. This way, the
    # existing prompting will pick if this should be "sandstorm" (which
    # it should be if we're running the install script as root) or the
    # currently-logged-in user (which it should be if we're not root).

    # Do not bother setting a DIR. This way, the existing prompting will
    # pick between /opt/sandstorm and $HOME/sandstorm, depending on if
    # the install is being done as root or not. It will use /opt/sandstorm
    # in all cases if the script is run without the HOME environment variable.
  fi
}

full_server_install() {
  # The full server install assumes you are OK with using root. If
  # you're not, you should choose the development server and customize
  # it to your heart's content.
  if [ "yes" != "${PREFER_ROOT}" ] ; then
    REPORT=no fail "E_AUTO_NEEDS_SUDO" "The automatic setup process requires sudo. Try again with option 2, development server, to customize."
  fi

  if [ "yes" = "$USE_DEFAULTS" ] ; then
    if [ -z "${DESIRED_SANDCATS_NAME-}" ] ; then
      local MSG="For now, USE_DEFAULTS for full server installs requires a DESIRED_SANDCATS_NAME variable."
      MSG="$MSG If you need support for non-sandcats full-server unattended installs, please file a bug."
      fail "E_USE_DEFAULTS_NEEDS_DESIRED_SANDCATS_NAME" "$MSG"
    else
      if [ -z "${SANDCATS_DOMAIN_RESERVATION_TOKEN:-}" ] ; then
        local MSG="When operating in USE_DEFAULTS mode, if you want a sandcats.io domain,"
        MSG="$MSG you must pre-reserve it before running this script. Specify it via the"
        MSG="$MSG SANDCATS_DOMAIN_RESERVATION_TOKEN environment variable."
        fail "E_USE_DEFAULTS_NEEDS_DESIRED_SANDCATS_NAME" "$MSG"
      fi
    fi

    # If they said USE_DEFAULTS then they don't need to be prompted.
    ACCEPTED_FULL_SERVER_INSTALL="yes"
  fi

  # Use port 25 for email, if we can. This logic only gets executed for "full servers."
  disable_smtp_port_25_if_port_unavailable
  local PLANNED_SMTP_PORT="30025"
  if [ "yes" = "$PORT_25_AVAILABLE" ] ; then
    PLANNED_SMTP_PORT="25"
  fi

  if [ "yes" != "${ACCEPTED_FULL_SERVER_INSTALL:-}" ]; then
    # Disable Sandcats HTTPS if ports 80 or 443 aren't available.
    disable_https_if_ports_unavailable

    echo "We're going to:"
    echo ""
    echo "* Install Sandstorm in $DEFAULT_DIR_FOR_ROOT"
    echo "* Automatically keep Sandstorm up-to-date"
    if [ "yes" == "$SANDCATS_GETCERTIFICATE" ] ; then
      echo "* Configure auto-renewing HTTPS if you use a subdomain of sandcats.io"
    fi
    echo "* Create a service user ($DEFAULT_SERVER_USER) that owns Sandstorm's files"
    if [ "unknown" == "$INIT_SYSTEM" ]; then
      echo "*** WARNING: Could not detect how to run Sandstorm at startup on your system. ***"
    else
      echo "* Configure Sandstorm to start on system boot (with $INIT_SYSTEM)"
    fi
    echo "* Listen for inbound email on port ${PLANNED_SMTP_PORT}."
    echo ""

    # If we're not root, we will ask if it's OK to use sudo.
    if [ "yes" != "$CURRENTLY_UID_ZERO" ]; then
      echo "To set up Sandstorm, we will need to use sudo."
    else
      echo "Rest assured that Sandstorm itself won't run as root."
    fi

    if prompt-yesno "OK to continue?" "yes"; then
      ACCEPTED_FULL_SERVER_INSTALL=yes
    else
      ACCEPTED_FULL_SERVER_INSTALL=no
    fi

    if [ "yes" = "$ACCEPTED_FULL_SERVER_INSTALL" ] &&
      [ "yes" = "$SHOW_MESSAGE_ABOUT_NEEDING_PORTS_OPEN" ] ; then
      echo ""
      echo "NOTE: It looks like your system already has some other web server installed"
      echo "      (port 80 and/or 443 are taken), so Sandstorm cannot act as your main"
      echo "      web server."
      echo ""
      echo "      This script can set up Sandstorm to run on port $DEFAULT_PORT instead,"
      echo "      without HTTPS. This makes sense if you're OK with typing the port number"
      echo "      into your browser whenever you access Sandstorm and you don't need"
      echo "      security. This also makes sense if you are going to set up a reverse proxy;"
      echo "      if so, see https://docs.sandstorm.io/en/latest/administering/reverse-proxy/"
      echo ""
      echo "      If you want, you can quit this script with Ctrl-C now, and go uninstall"
      echo "      your other web server, and then run this script again. It is also OK to"
      echo "      proceed if you want."
      echo ""
      if ! prompt-yesno "OK to skip automatic HTTPS setup & bind to port $DEFAULT_PORT instead?" "yes" ; then
        fail "E_USER_REFUSED_DEFAULT_PORT" "Exiting now. You can re-run the installer whenever you are ready."
      fi
    fi

    # If they are OK continuing, and the script is not running as root
    # at the moment, then re-run ourselves as root.
    #
    # Pass along enough information so that the script will keep
    # executing smoothly, so the user doesn't have to re-answer
    # questions.
    if [ "yes" != "$CURRENTLY_UID_ZERO" ] ; then
      if [ "yes" = "$ACCEPTED_FULL_SERVER_INSTALL" ] ; then
        rerun_script_as_root CHOSEN_INSTALL_MODE=1 \
                             ACCEPTED_FULL_SERVER_INSTALL=yes \
                             OVERRIDE_SANDCATS_BASE_DOMAIN="${OVERRIDE_SANDCATS_BASE_DOMAIN:-}" \
                             OVERRIDE_SANDCATS_API_BASE="${OVERRIDE_SANDCATS_API_BASE:-}" \
                             OVERRIDE_SANDCATS_GETCERTIFICATE="${SANDCATS_GETCERTIFICATE}" \
                             OVERRIDE_NC_PATH="${OVERRIDE_NC_PATH:-}" \
                             OVERRIDE_SANDCATS_CURL_PARAMS="${OVERRIDE_SANDCATS_CURL_PARAMS:-}"
      fi

      # If we're still around, it means they declined to run us as root.
      echo ""
      echo "The automatic setup script needs root in order to:"
      echo "* Create a separate user to run Sandstorm as, and"
      echo "* Set up Sandstorm to start on system boot."
      echo ""
      fail "E_DECLINED_AUTO_SETUP_DETAILS" "For a customized install, please re-run install.sh, and choose option (2) "\
           "to do a development install."
    fi
  fi

  # Accepting this indicates a few things.
  if [ "yes" = "${ACCEPTED_FULL_SERVER_INSTALL}" ]; then
    UPDATE_CHANNEL="$DEFAULT_UPDATE_CHANNEL"
    DIR="$DEFAULT_DIR_FOR_ROOT"
    USE_EXTERNAL_INTERFACE="yes"
    USE_SANDCATS="yes"
    START_AT_BOOT="yes"
    DESIRED_SERVER_USER="$DEFAULT_SERVER_USER"
    PORT="${DEFAULT_PORT}"
    MONGO_PORT="6081"
    SMTP_LISTEN_PORT="${PLANNED_SMTP_PORT}"
  else
    REPORT=no fail "E_USER_WANTS_CUSTOM_SETTINGS" "If you prefer a more manual setup experience, try installing in development mode."
  fi
}

sandcats_configure() {
  # We generate the public key before prompting for a desired hostname
  # so that when the user presses enter, we can try to register the
  # hostname, and if that succeeds, we are totally done. This avoids a
  # possible time-of-check-time-of-use race.
  echo -n "As a Sandstorm user, you are invited to use a free Internet hostname "
  echo "as a subdomain of sandcats.io,"
  echo "a service operated by the Sandstorm development team."

  sandcats_generate_keys

  echo ""
  echo "Sandcats.io protects your privacy and is subject to terms of use. By using it,"
  echo "you agree to the terms of service & privacy policy available here:"
  echo "https://sandcats.io/terms https://sandcats.io/privacy"
  echo ""

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
    SS_HOSTNAME="${SS_HOSTNAME:-$(hostname -f 2>/dev/null || hostname)}"
  else
    BIND_IP=127.0.0.1
    SS_HOSTNAME=local.sandstorm.io
    if [ "yes" != "$USE_DEFAULTS" ] ; then
      echo "Note: local.sandstorm.io maps to 127.0.0.1, i.e. your local machine."
      echo "For reasons that will become clear in the next step, you should use this"
      echo "instead of 'localhost'."
    fi
  fi

  # A typical server's DEFAULT_BASE_URL is its hostname plus port over HTTP. If the port is 80, then
  # don't add it to BASE_URL to avoid triggering this bug:
  # https://github.com/sandstorm-io/sandstorm/issues/2252
  local PORT_SUFFIX=""
  if [ "$PORT" = "80" ] ; then
    PORT_SUFFIX=""
  else
    PORT_SUFFIX=":${PORT}"
  fi

  DEFAULT_BASE_URL="http://${SS_HOSTNAME}${PORT_SUFFIX}"

  if [ "$USE_HTTPS" = "yes" ]; then
    DEFAULT_BASE_URL="https://$SS_HOSTNAME"
    HTTPS_PORT=443
    PORT=80
  fi

  if [ "yes" = "$SANDCATS_SUCCESSFUL" ] ; then
    # Do not prompt for BASE_URL configuration if Sandcats bringup
    # succeeded.
    BASE_URL="$DEFAULT_BASE_URL"
  else
    BASE_URL=$(prompt "URL users will enter in browser:" "$DEFAULT_BASE_URL")
    if ! [[ "$BASE_URL" =~ ^http(s?):// ]] ; then
      local PROPOSED_BASE_URL="http://${BASE_URL}"
      echo "** You entered ${BASE_URL}, which needs http:// at the front. I can use:" >&2
      echo "        ${PROPOSED_BASE_URL}" >&2
      if prompt-yesno "Is this OK?" yes; then
        BASE_URL="${PROPOSED_BASE_URL}"
      else
        configure_hostnames
      fi
    fi
  fi

  # If the BASE_URL looks like localhost, then we had better use a
  # DEFAULT_WILDCARD of local.sandstorm.io so that wildcard DNS works.
  if [[ "$BASE_URL" =~ ^http://localhost(|:[0-9]*)(/.*)?$ ]]; then
    DEFAULT_WILDCARD=*.local.sandstorm.io${BASH_REMATCH[1]}
  elif [[ "$BASE_URL" =~ ^[^:/]*://([^/]*)/?$ ]]; then
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
  fi

  # Check for the existence of any partial Sandstorm installation. Note that by default, the
  # Sandstorm uninstall process will retain $DIR/sandstorm.conf and $DIR/var. Since the install
  # script can't reliably use those to preseed a new Sandstorm install, we still bail out in that
  # situation.
  if [ -e "$DIR/sandstorm.conf" ] || [ -e "$DIR/var" ] || [ -e "$DIR/sandstorm" ] ; then
    # Clear the previous line, since in many cases, it's a "echo -n".
    error ""
    error "This script is trying to install to ${DIR}."
    error ""
    error "You seem to already have a ${DIR} directory with a Sandstorm installation inside. You should either:"
    error ""
    error "1. Reconfigure that Sandstorm install using its configuration file -- ${DIR}/sandstorm.conf -- or the admin interface. See docs at:"
    error "https://docs.sandstorm.io/en/latest/administering/"
    error ""
    error "2. Uninstall Sandstorm before attempting to perform a new install. Even if you created a sandcats.io hostname, it is safe to uninstall so long as you do not need the data in your Sandstorm install. When you re-install Sandstorm, you can follow a process to use the old hostname with the new install. See uninstall docs at:"
    error "https://docs.sandstorm.io/en/latest/install/#uninstall"
    error ""
    error "3. Use a different target directory for the new Sandstorm install. Try running install.sh with the -d option."
    error ""
    error "4. Retain your data, but restore your Sandstorm code and configuration to a fresh copy. To do that, keep a backup  of ${DIR}/var and then do a fresh install; stop the Sandstorm service, and restore your backup of ${DIR}/var. You may need to adjust permissions after doing that."
    REPORT=no fail "E_DIR_ALREADY_EXISTS" "Please try one of the above. Contact https://groups.google.com/d/forum/sandstorm-dev for further help."
  fi

  mkdir -p "$DIR"
  cd "$DIR"
}

choose_smtp_port() {
  # If SMTP_LISTEN_PORT is already decided, then don't bother asking.
  if [ ! -z "${SMTP_LISTEN_PORT:-}" ] ; then
    return
  fi

  local REQUESTED_SMTP_PORT=$(prompt-numeric "Sandstorm grains can receive email. What port should Sandstorm listen on, for inbound SMTP?" "${DEFAULT_SMTP_PORT}")
  if [ -z "${REQUESTED_SMTP_PORT}" ] ; then
    choose_smtp_port
  else
    SMTP_LISTEN_PORT="${REQUESTED_SMTP_PORT}"
  fi
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
    fail "E_CONF_DOES_NOT_SET_SERVER_USER" "Existing config does not set SERVER_USER. Please fix or delete it."
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
    CREATE_SERVER_USER="yes"
    ADD_SUDO_USER_TO_SERVER_GROUP="no"
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
  if [ "yes" != "${CREATE_SERVER_USER:-}" ] ; then
    if prompt-yesno "User account '$SERVER_USER' doesn't exist. Create it?" yes ; then
      CREATE_SERVER_USER=yes
    fi
  fi

  # If people don't want us to create it, then let's bail now.
  if [ "yes" != "${CREATE_SERVER_USER:-}" ] ; then
    return
  fi

  # OK! Let's proceed.
  #
  # To create the server user, we first try `useradd`, which is widely available on most
  # distros. If that isn't available, it's likely we're running on a busybox based system.
  # busybox provides an `adduser` applet, so if that command links to the busybox binary
  # we it instead.
  #
  # Note that debian provides an `adduser` command as well, but its usage is different.
  # useradd is available on debian anyway, so we'll end up using that.
  if which useradd >/dev/null; then
    # Per the man page for useradd, USERGROUPS_ENAB in /etc/login.defs controls if useradd
    # will automatically create a group for this user (the new group would have the same
    # name as the new user). On systems such as OpenSuSE where that flag is set to false
    # by default, or on systems where the administrator has personally tuned that flag,
    # we need to provide --user-group to useradd so that it creates the group.
    useradd --system --user-group "$SERVER_USER"
  elif [ "$(basename $(readlink $(which adduser)))" = busybox ]; then
    # With busybox we need to separately create the user's group.
    addgroup -S "$SERVER_USER"
    adduser -S -G "$SERVER_USER" "$SERVER_USER"
  else
    fail "E_NO_USERADD" \
      "Couldn't find a command with which to add a user (either useradd or busybox)."
  fi

  echo "Note: Sandstorm's storage will only be accessible to the group '$SERVER_USER'."

  # If SUDO_USER is non-empty, we let the user opt in to adding
  # themselves to the storage group.

  # The easy-install opts out of this flow by setting
  # ADD_SUDO_USER_TO_SERVER_GROUP=no.
  if [ "no" = "${ADD_SUDO_USER_TO_SERVER_GROUP:-}" ] ; then
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

  PORT=$(prompt-numeric "Server main HTTP port:" $DEFAULT_PORT)

  while [ "$PORT" -lt 1024 ]; do
    echo "Ports below 1024 require root privileges. Sandstorm does not run as root."
    echo "To use port $PORT, you'll need to set up a reverse proxy like nginx that "
    echo "forwards to the internal higher-numbered port. The Sandstorm git repo "
    echo "contains an example nginx config for this."
    PORT=$(prompt-numeric "Server main HTTP port:" $DEFAULT_PORT)
  done
}

choose_mongo_port() {
  # If there is already a MONGO_PORT chosen, then don't bother asking.
  if [ ! -z "${MONGO_PORT:-}" ] ; then
    return
  fi

  # If the port we'll bind is less than 1024, then default to MONGO_PORT of 6081 because
  # mongo can't listen on root-owned ports in our configuration.
  local DEFAULT_MONGO_PORT="$((PORT + 1))"
  if [ "$PORT" -lt 1024 ] ; then
    DEFAULT_MONGO_PORT="6081"
  fi

  MONGO_PORT=$(prompt-numeric "Database port (choose any unused port):" "${DEFAULT_MONGO_PORT}")
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
  writeConfig SERVER_USER PORT MONGO_PORT BIND_IP BASE_URL WILDCARD_HOST UPDATE_CHANNEL ALLOW_DEV_ACCOUNTS SMTP_LISTEN_PORT > sandstorm.conf
  if [ "yes" = "$SANDCATS_SUCCESSFUL" ] ; then
    writeConfig SANDCATS_BASE_DOMAIN >> sandstorm.conf
  fi
  if [ "yes" = "$USE_HTTPS" ] ; then
    writeConfig HTTPS_PORT >> sandstorm.conf
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
  # NOTE: The type is install_v2. We use the "type" value when calculating how many people attempted
  # to do a Sandstorm install. We had to stop using "install" because vagrant-spk happens to use
  # &type=install during situations that we do not want to categorize as an attempt by a human to
  # install Sandstorm.
  BUILD="$(curl -A "$CURL_USER_AGENT" -fs "https://install.sandstorm.io/$DEFAULT_UPDATE_CHANNEL?from=0&type=install_v2")"
  BUILD_DIR="sandstorm-${BUILD}"

  if [[ ! "$BUILD" =~ ^[0-9]+$ ]]; then
    fail "E_INVALID_BUILD_NUM" "Server returned invalid build number: $BUILD"
  fi

  do-download() {
    rm -rf "${BUILD_DIR}"
    WORK_DIR="$(mktemp -d ./sandstorm-installer.XXXXXXXXXX)"
    local URL="https://dl.sandstorm.io/sandstorm-$BUILD.tar.xz"
    echo "Downloading: $URL"
    retryable_curl "$URL" "$WORK_DIR/sandstorm-$BUILD.tar.xz"
    retryable_curl "$URL.sig" "$WORK_DIR/sandstorm-$BUILD.tar.xz.sig"

    if which gpg > /dev/null; then
      export GNUPGHOME="$WORK_DIR/.gnupg"
      mkdir -m 0700 -p "$GNUPGHOME"

      # Regenerate with: gpg --armor --export 160D2D577518B58D94C9800B63F227499DA8CCBD
      gpg --dearmor > "$WORK_DIR/sandstorm-keyring.gpg" << __EOF__
-----BEGIN PGP PUBLIC KEY BLOCK-----
Version: GnuPG v1

mQENBFX8ypkBCAC8sjX5yZqKdW8nY7aE/GpVeS+qSCbpYSJwixYNFXbz3MQihR3S
suvg5uw1KyuQb23c0LwirfxazVf7txKhQNaNU3ek62LG3wcGeBrvQGsIUMbkatay
/163CLeVWfSK1Z4pFc4dhdjXYSOz0oZxd7Mp78crBbGKmyn7PtzdAqt+XfEXNuee
cDbx++P57n5s5xc5fQWznt333IMgmgTREGUROfh4kL376rFAS208XIywJlUVkoKM
kIzgcjevFGwYKdsLigHXCDp9toQHl8oPjFV+RE8Br8ciJlMp9CqCfHGwj0Orxasc
e9moLqqUc+iKdg9bQfuAbJ/jFNhGmV/CVv9tABEBAAG0LlNhbmRzdG9ybS5pbyAo
cmVsZWFzZXMpIDxzdXBwb3J0QHNhbmRzdG9ybS5pbz6JATgEEwECACIFAlX8ypkC
GwMGCwkIBwMCBhUIAgkKCwQWAgMBAh4BAheAAAoJEGPyJ0mdqMy91bYH/iTg9qbw
G3th57Yf70NtyMJE3UBFDYDNAgT45UBEHoHhQM5cdFu/EIHggOKl/A2zL19Nh555
5F5o3jiJChQ0cvpoVnDdA5lRKD9iK6hzAba9fCVAx/od1PULQP7KV+uHTQuclSFO
DBvpgT8bMY9LmlpTl+l2lvYd+c50w3jZMFwh8JrJYAc3X0kBfVEywVZkjH8Nw5nD
v/j5Of3XXfEg84tNyWSYUMrYVORJyfHtA9e3JXNv5BMxH73AVLnyCJhCaodQsC6Z
hFkHUvvRb58ZqKXMtLYTd/8XLIvpkgRNX6EHWDslJh3BaBwHSuqDNssh1TW5xPjA
9vkPDzeZfLkuxpy5AQ0EVfzKmQEIANyi22M/3KhkghsPA6Rpha1lx6JJCb4p7E21
y82OGFUwcMpZkSgh1lARgp/Mvc2CHhAXi6NkGbgYc1q5rgARSvim2EMZNQOEqRb9
teEeI3w7Nz8Q/WoWck9WaXg8EdELtBOXYgVEirVddUl6ftUvCeBh3hE2Y/CLQSXL
CYXdQ2/MN6xV8tepuWOu0aPxxPUNea9ceDNZ8/CXEL32pzv9SUX/3KgSnFTzmxNP
thzXGuaAQGMZRu3cdTSeK9UUX4L3lxv7p0nE/2K18MU3FayTJqspfUCc4BgHZRMN
sh+2/YNfJgi0uWex1WnU94ZIp4A0uic54bU1ZECSwxg81KHaEEkAEQEAAYkBHwQY
AQIACQUCVfzKmQIbDAAKCRBj8idJnajMvZgPB/0THpTPnfsYNkwQrBsrTq413ZTF
JmVyeZ9xnGDImOdyHhGLlnLC1YEnaNUVEyMKifya4TF2utrLrsMT9TC/dWvFsYlJ
oMcUpaSlrFoAoPp3pdOGCIRYNhWGHoxy0Ti1WAa/6A+GoHJpUEz85/jD4vjgYlCX
ZFW1Pji9PbdIZFZQR4FyYBkkZOUq6yyTNR0syQPVy3EsPVvXzszm2zV/1YjGymgj
MKeYR9+VU+PlFAY9wwLWLTFeSzxTyVjbPwF5bWHV32GM8g0/NgA6a1JLL40v7pqf
uYvFk2KJpo3gZNGJ72gLkSzie7Eu1/V67JIG9TwfrJUEj8Uwd5zPv1MOqfWl
=OiS5
-----END PGP PUBLIC KEY BLOCK-----
__EOF__

      if gpg --no-default-keyring --keyring $WORK_DIR/sandstorm-keyring.gpg --status-fd 1 \
             --verify $WORK_DIR/sandstorm-$BUILD.tar.xz{.sig,} 2>/dev/null | \
          grep -q '^\[GNUPG:\] VALIDSIG 160D2D577518B58D94C9800B63F227499DA8CCBD '; then
        echo "GPG signature is valid."
      else
        rm -rf sandstorm-$BUILD
        fail "E_INVALID_GPG_SIG" "GPG signature is NOT valid! Please report to security@sandstorm.io immediately!"
      fi

      unset GNUPGHOME
    else
      echo "WARNING: gpg not installed; not verifying signatures (but it's HTTPS so you're probably fine)" >&2
    fi

    tar Jxof "$WORK_DIR/sandstorm-$BUILD.tar.xz"
    rm -rf "$WORK_DIR"

    if [ ! -e "$BUILD_DIR" ]; then
      fail "E_BAD_PACKAGE" "Bad package -- did not contain $BUILD_DIR directory."
    fi

    if [ ! -e "$BUILD_DIR/buildstamp" ] || \
       [ $(stat -c %Y "$BUILD_DIR/buildstamp") -lt $(( $(date +%s) - 30*24*60*60 )) ]; then
      rm -rf "$BUILD_DIR"
      fail "E_PKG_STALE" "The downloaded package seems to be more than a month old. Please verify that your" \
           "computer's clock is correct and try again. It could also be that an attacker is" \
           "trying to trick you into installing an old version. Please contact" \
           "security@sandstorm.io if the problem persists."
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

  local ADMIN_TOKEN_PATH=
  if [ -e "${ADMIN_TOKEN_PATH}" ] ; then
    ADMIN_TOKEN_PATH="var/sandstorm/adminToken"
  fi

  # Set ownership of files.  We want the dirs to be root:sandstorm but the contents to be
  # sandstorm:sandstorm.
  chown -R $SERVER_USER:$GROUP var/{log,pid,mongo} var/sandstorm/{apps,grains,downloads} $ADMIN_TOKEN_PATH
  chown root:$GROUP var/{log,pid,mongo,sandstorm} var/sandstorm/{apps,grains,downloads} $ADMIN_TOKEN_PATH
  chmod -R g=rwX,o= var/{log,pid,mongo,sandstorm} var/sandstorm/{apps,grains,downloads} $ADMIN_TOKEN_PATH
}

install_sandstorm_symlinks() {
  # If not running the installer as root, we can't modify
  # /usr/local/bin, so we have to skip this.
  if [ "yes" != "$CURRENTLY_UID_ZERO" ]; then
    return
  fi

  local FAILED_TO_WRITE_SYMLINK="no"

  # Install tools.
  ln -sfT $PWD/sandstorm /usr/local/bin/sandstorm || FAILED_TO_WRITE_SYMLINK=yes
  ln -sfT $PWD/sandstorm /usr/local/bin/spk || FAILED_TO_WRITE_SYMLINK=yes

  # If /usr/local/bin is not actually writeable, even though we are root, then bail on this for now.
  # That can happen on e.g. CoreOS; see https://github.com/sandstorm-io/sandstorm/issues/1660
  # the bash "-w" does not detect read-only mounts, so we use a behavior check above.
  if [ "${FAILED_TO_WRITE_SYMLINK}" = "yes" ] ; then
    echo ""
    echo "*** WARNING: /usr/local/bin was not writeable. To run sandstorm or spk manually, use:"
    echo " - $PWD/sandstorm"
    echo " - $PWD/sandstorm spk"
    echo ""
    return
  fi

}

ask_about_starting_at_boot() {
  # Starting Sandstorm at boot cannot work if we are not root by this point.
  if [ "$CURRENTLY_UID_ZERO" != "yes" ] ; then
    START_AT_BOOT="no"
  fi

  # If we already know if we want to start the thing at boot, we can skip asking.
  if [ ! -z "${START_AT_BOOT:-}" ] ; then
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
After=local-fs.target remote-fs.target network-online.target
Requires=local-fs.target remote-fs.target
Wants=network-online.target

[Service]
Type=forking
ExecStart=$PWD/sandstorm start
ExecStop=$PWD/sandstorm stop

[Install]
WantedBy=multi-user.target
__EOF__
  systemctl enable sandstorm
  systemctl start sandstorm
  STARTED_SANDSTORM="yes"
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
  if [ "$(which update-rc.d)" != "" ]; then
    update-rc.d sandstorm defaults
  elif [ "$(which rc-update)" != "" ]; then
    rc-update add sandstorm
  else
    echo "WARNING: I couldn't figure out how to make the Sandstorm init script active on" >&2
    echo "  your system; neither update-rc.d nor rc-update commands seem to exist. Sandstorm" >&2
    echo "  will not start automatically at boot until you mark its init script active." >&2
  fi

  # Start it right now.
  service sandstorm start
  STARTED_SANDSTORM="yes"
}

generate_admin_token() {
  # If dev accounts are enabled, the user does not need an admin token.
  if [ "yes" = "${ALLOW_DEV_ACCOUNTS}" ] ; then
    return
  fi

  # Allow the person running the install.sh script to pre-generate an admin token, specified as an
  # environment variable, so that they can ignore the output text of install.sh.
  if [ ! -z "${ADMIN_TOKEN:-}" ] ; then
    local TMPFILENAME="$(mktemp ./var/sandstorm/adminTokenTmp.XXXXXXXXXX)"
    echo -n "$ADMIN_TOKEN" > "$TMPFILENAME"
    local FILENAME="./var/sandstorm/adminToken"
    mv "$TMPFILENAME" "$FILENAME"
    chmod 0640 "$FILENAME"
    chgrp "$SERVER_USER" "$FILENAME"
    return
  fi

  ADMIN_TOKEN=$(./sandstorm admin-token --quiet)
}

print_success() {
  echo ""
  if [ "yes" = "$SANDSTORM_NEEDS_TO_BE_STARTED" ] ; then
    echo "Installation complete. To start your server now, run:"
    echo "  $DIR/sandstorm start"
    echo "Once that's done, visit this link to start using it:"
  else
    echo -n "Your server is now online! "
    echo "Visit this link to start using it:"
  fi

  echo ""

  # If there is an admin token at this point, print an admin token URL.  Otherwise, don't. Note that
  # when dev accounts are enabled, it is advantageous to not print an admin token URL.
  if [ ! -z "${ADMIN_TOKEN:-}" ] ; then
    echo "  ${BASE_URL:-(unknown; bad config)}/setup/token/$ADMIN_TOKEN"
    echo ""
    echo "NOTE: This URL expires in 15 minutes. You can generate a new setup URL by running"
    echo "'sudo sandstorm admin-token' from the command line."
  else
    echo "  ${BASE_URL:-(unknown; bad config)}/"
  fi
  if [ "yes" = "${ALLOW_DEV_ACCOUNTS}" ] ; then
   echo ""
   echo "NOTE: Use the passwordless admin account called Alice for convenient dev login (since you have 'dev accounts' enabled)."
  fi
  echo ""

  echo
  echo "To learn how to control the server, run:"
  if [ "yes" = "$CURRENTLY_UID_ZERO" ] ; then
    echo "  sandstorm help"
  else
    echo "  $DIR/sandstorm help"
  fi
}

sandcats_provide_help() {
  echo "Sandcats.io is a free dynamic DNS service run by the Sandstorm development team."
  echo ""
  echo "You can:"
  echo ""
  echo "* Read more about it at:"
  echo "  https://github.com/sandstorm-io/sandstorm/wiki/Sandcats-dynamic-DNS"
  echo ""
  echo "* Recover access to a domain you once registered with sandcats"
  echo ""
  echo "* Just press enter to go to the previous question."
  sandcats_recover_domain
}

sandcats_recover_domain() {
  DESIRED_SANDCATS_NAME=$(prompt "What Sandcats subdomain do you want to recover?" "none")

  # If the user wants none of our help, then go back to registration.
  if [ "none" = "$DESIRED_SANDCATS_NAME" ] ; then
    sandcats_register_name
    return
  fi

  # If the user gave us a hostname that contains a dot, tell them they need to re-enter it.
  if [[ $DESIRED_SANDCATS_NAME =~ [.] ]] ; then
    echo ""
    echo "You entered: $DESIRED_SANDCATS_NAME"
    echo ""
    echo "but this function just wants the name of your subdomain, not including any dot characters."
    echo "Please try again."
    echo ""
    sandcats_recover_domain
    return
  fi

  echo "OK. We will send a recovery token to the email address on file. Type no to abort."
  OK_TO_CONTINUE=$(prompt "OK to continue?" "yes")
  if [ "no" = "$OK_TO_CONTINUE" ] ; then
    sandcats_register_name
    return
  fi

  # First, we attempt to send the user a domain recovery token.
  local LOG_PATH="var/sandcats/sendrecoverytoken-log"
  touch "$LOG_PATH"
  chmod 0640 "$LOG_PATH"
  HTTP_STATUS=$(
    dotdotdot_curl \
      --silent \
      --max-time 20 \
      $SANDCATS_CURL_PARAMS \
      -A "$CURL_USER_AGENT" \
      -X POST \
      --data-urlencode "rawHostname=$DESIRED_SANDCATS_NAME" \
      --output "$LOG_PATH" \
      -w '%{http_code}' \
      -H 'X-Sand: cats' \
      -H "Accept: text/plain" \
      "${SANDCATS_API_BASE}/sendrecoverytoken")

  if [ "200" != "$HTTP_STATUS" ] ; then
    error "$(cat $LOG_PATH)"
    sandcats_recover_domain
    return
  fi

  # Show the server's output, which presumably is some happy
  # message.
  cat "$LOG_PATH"
  # Make sure that is on a line of its own.
  echo ''
  TOKEN=$(prompt "Please enter the token that we sent to you by email." '')

  # If the token is empty, then they just hit enter; take them to the start of help.
  if [ -z "$TOKEN" ] ; then
    error "Empty tokens are not valid."
    sandcats_recover_domain
    return
  fi

  # Let's submit that token to the server's "recover" endpoint.
  #
  # This action registers the new key as the authoritative key for
  # this hostname. It also sends an email to the user telling them
  # that we changed the key they have on file.
  local LOG_PATH="var/sandcats/recover-log"
  touch "$LOG_PATH"
  chmod 0640 "$LOG_PATH"
  HTTP_STATUS=$(
      dotdotdot_curl \
      --silent \
      --max-time 20 \
      $SANDCATS_CURL_PARAMS \
      -A "$CURL_USER_AGENT" \
      -X POST \
      --data-urlencode "rawHostname=$DESIRED_SANDCATS_NAME" \
      --data-urlencode "recoveryToken=$TOKEN" \
      --output "$LOG_PATH" \
      -w '%{http_code}' \
      -H 'X-Sand: cats' \
      -H "Accept: text/plain" \
      --cert var/sandcats/id_rsa.private_combined \
      "${SANDCATS_API_BASE}/recover")

  if [ "200" != "$HTTP_STATUS" ] ; then
    error "$(cat $LOG_PATH)"
    sandcats_recover_domain
    return
  fi

  # Show the server's output, which presumably is some happy
  # message.
  cat "$LOG_PATH"
  # Make sure that is on a line of its own.
  echo ''

  # Now we can do a call to /update, which we will do silently on the
  # user's behalf. This uses the new key we registered (via /recover)
  # and sets the IP address for this host in the sandcats.io DNS
  # service.
  local LOG_PATH="var/sandcats/update-log"
  touch "$LOG_PATH"
  chmod 0640 "$LOG_PATH"
  HTTP_STATUS=$(
    dotdotdot_curl \
      --silent \
      --max-time 20 \
      $SANDCATS_CURL_PARAMS \
      -A "$CURL_USER_AGENT" \
      -X POST \
      --data-urlencode "rawHostname=$DESIRED_SANDCATS_NAME" \
      --output "$LOG_PATH" \
      -w '%{http_code}' \
      -H 'X-Sand: cats' \
      -H "Accept: text/plain" \
      --cert var/sandcats/id_rsa.private_combined \
      "${SANDCATS_API_BASE}/update")

  if [ "200" != "$HTTP_STATUS" ] ; then
    error "$(cat $LOG_PATH)"
    sandcats_recover_domain
    return
  fi

  # Show the server's happy message.
  cat "$LOG_PATH"
  # Make sure that is on a line of its own.
  echo ''

  SANDCATS_SUCCESSFUL="yes"
  SS_HOSTNAME="${DESIRED_SANDCATS_NAME}.${SANDCATS_BASE_DOMAIN}"
  USE_EXTERNAL_INTERFACE="yes"
  USE_HTTPS="yes"
  echo "Congratulations! You're all configured to use ${DESIRED_SANDCATS_NAME}.${SANDCATS_BASE_DOMAIN}."
  echo "Your credentials to use it are in $(readlink -f var/sandcats); consider making a backup."
}

sandcats_registerreserved() {
  echo "Registering your pre-reserved domain."
  local LOG_PATH
  LOG_PATH="var/sandcats/registerreserved-log"
  touch "$LOG_PATH"
  chmod 0640 "$LOG_PATH"
  HTTP_STATUS=$(
    dotdotdot_curl \
      --silent \
      --max-time 20 \
      $SANDCATS_CURL_PARAMS \
      -A "$CURL_USER_AGENT" \
      -X POST \
      --data-urlencode "domainReservationToken=$SANDCATS_DOMAIN_RESERVATION_TOKEN" \
      --data-urlencode "rawHostname=$DESIRED_SANDCATS_NAME" \
      --output "$LOG_PATH" \
      -w '%{http_code}' \
      -H 'X-Sand: cats' \
      -H "Accept: text/plain" \
      --cert var/sandcats/id_rsa.private_combined \
      "${SANDCATS_API_BASE}/registerreserved")

  if [ "200" = "$HTTP_STATUS" ]
  then
    # Show the server's output, which presumably is some happy
    # message.
    cat "$LOG_PATH"
    # Make sure that is on a line of its own.
    echo ''
    # Set these global variables to inform the installer down the
    # road.
    SS_HOSTNAME="${DESIRED_SANDCATS_NAME}.${SANDCATS_BASE_DOMAIN}"
    USE_EXTERNAL_INTERFACE="yes"
    USE_HTTPS="yes"
    SANDCATS_SUCCESSFUL="yes"
    echo "Congratulations! We have registered your ${DESIRED_SANDCATS_NAME}.${SANDCATS_BASE_DOMAIN} name."
    echo "Your credentials to use it are in $(readlink -f var/sandcats); consider making a backup."
  else
    # Show the server's output, and bail out.
    #
    # TODO(soon): Wait 1 minute in case the sandcats.io service had a brief hiccup, and retry (let's
    # say) 5 times.
    fail "E_SANDCATS_REGISTER_RESERVED_SRV_FAIL" "$(cat "$LOG_PATH")"
  fi
}

sandcats_register_name() {
  # We allow environment variables to override some details of the
  # Sandcats service, so that during development, we can test against
  # a non-production Sandcats service.
  SANDCATS_API_BASE="${OVERRIDE_SANDCATS_API_BASE:-https://sandcats.io}"
  SANDCATS_CURL_PARAMS="${OVERRIDE_SANDCATS_CURL_PARAMS:-}"

  # If there is a SANDCATS_DOMAIN_RESERVATION_TOKEN provided, then we call a different function to
  # do the work.
  if [ ! -z "${SANDCATS_DOMAIN_RESERVATION_TOKEN:-}" ] ; then
    sandcats_registerreserved
    return
  fi

  echo "Choose your desired Sandcats subdomain (alphanumeric, max 20 characters)."
  echo "Type the word none to skip this step, or help for help."
  DESIRED_SANDCATS_NAME=$(prompt "What *.${SANDCATS_BASE_DOMAIN} subdomain would you like?" '')

  # If they just press enter, insist that they type either the word
  # "none" or provide a name they want to register.
  if [ -z "$DESIRED_SANDCATS_NAME" ] ; then
    sandcats_register_name
    return
  fi

  # If the user really wants none of our sandcats help, then bail out.
  if [ "none" = "$DESIRED_SANDCATS_NAME" ] ; then
    return
  fi

  # If the user wants help, offer help.
  if [ "help" = "$DESIRED_SANDCATS_NAME" ] ; then
    sandcats_provide_help
    return
  fi

  # Validate the client-side, to avoid problems, against a slightly
  # less rigorous regex than the server is using.
  if ! [[ $DESIRED_SANDCATS_NAME =~ ^[0-9a-zA-Z-]{1,20}$ ]] ; then
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

  echo "Registering your domain."
  local LOG_PATH
  LOG_PATH="var/sandcats/register-log"
  touch "$LOG_PATH"
  chmod 0640 "$LOG_PATH"
  HTTP_STATUS=$(
    dotdotdot_curl \
      --silent \
      --max-time 20 \
      $SANDCATS_CURL_PARAMS \
      -A "$CURL_USER_AGENT" \
      -X POST \
      --data-urlencode "rawHostname=$DESIRED_SANDCATS_NAME" \
      --data-urlencode "email=$SANDCATS_REGISTRATION_EMAIL" \
      --output "$LOG_PATH" \
      -w '%{http_code}' \
      -H 'X-Sand: cats' \
      -H "Accept: text/plain" \
      --cert var/sandcats/id_rsa.private_combined \
      "${SANDCATS_API_BASE}/register")

  if [ "200" = "$HTTP_STATUS" ]
  then
    # Show the server's output, which presumably is some happy
    # message.
    cat "$LOG_PATH"
    # Make sure that is on a line of its own.
    echo ''
    # Set these global variables to inform the installer down the
    # road.
    SS_HOSTNAME="${DESIRED_SANDCATS_NAME}.${SANDCATS_BASE_DOMAIN}"
    USE_EXTERNAL_INTERFACE="yes"
    USE_HTTPS="yes"
    SANDCATS_SUCCESSFUL="yes"
    echo "Congratulations! We have registered your ${DESIRED_SANDCATS_NAME}.${SANDCATS_BASE_DOMAIN} name."
    echo "Your credentials to use it are in $(readlink -f var/sandcats); consider making a backup."
  else
    # Show the server's output, and re-run this function.
    error "$(cat "$LOG_PATH")"
    sandcats_register_name
    return
  fi
}

sandcats_configure_https() {
  # Insist that the experimental flag enabling this code was passed
  # into argv.
  if [ "yes" != "$SANDCATS_GETCERTIFICATE" ] ; then
    return
  fi

  # Insist that Sandcats setup successfully finished.
  if [ "yes" != "$SANDCATS_SUCCESSFUL" ] ; then
    return
  fi

  # OBSOLETE: We used to fetch a certificate here, but now we wait until the server is running
  #   and then do Let's Encrypt. To make sure the rest of the script works as expected, pretend
  #   HTTPS config was successful (it will be later).
  SANDCATS_HTTPS_SUCCESSFUL=yes
}

wait_for_server_bind_to_its_port() {
  # If we haven't started Sandstorm ourselves, it's not sensible to expect it to be listening.
  if [ "yes" != "${STARTED_SANDSTORM}" ] ; then
    return
  fi

  # For sandcats HTTPS, we have to generate the initial non-SNI key before Sandstorm binds to port
  # 443. So we let the user know it could be slow. For all users, using the admin token requires
  # that the server has started.
  local PORT_TO_CHECK="${HTTPS_PORT:-$PORT}"
  echo -n "Your server is coming online. Waiting up to 90 seconds..."
  local ONLINE_YET="no"
  for waited_n_seconds in $(seq 0 89); do
    is_port_bound "${BIND_IP}" "${PORT_TO_CHECK}" && ONLINE_YET="yes"
    if [ "$ONLINE_YET" == "yes" ] ; then
      echo ''
      break
    fi
    echo -n "."
    sleep 1
  done

  # One last check before we bail out.
  is_port_bound "${BIND_IP}" "${PORT_TO_CHECK}" && ONLINE_YET="yes"

  if [ "$ONLINE_YET" == "yes" ]; then
    return
  else
    fail "E_NEVER_LISTENED" "Your server never started listening."
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

    # If we are root, we must chown the Sandcats configuration
    # directory to the user that will be running Sandstorm.
    if [ "yes" = "$CURRENTLY_UID_ZERO" ] ; then
        chown "$SERVER_USER":"$SERVER_USER" var/sandcats
    fi

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
    chmod 0640 var/sandcats/id_rsa var/sandcats/id_rsa.pub var/sandcats/id_rsa.private_combined

    # If we are root, make sure the files are owned by the
    # $SERVER_USER. This way, Sandstorm can actually read them.
    if [ "yes" = "$CURRENTLY_UID_ZERO" ] ; then
        chown "$SERVER_USER":"$SERVER_USER" var/sandcats/id_rsa{,.pub,.private_combined}
    fi

    # Go to the start of the line, before the "..." that we
    # left on the screen, allowing future echo statements to
    # overwrite it.
    echo -ne '\r'
}

configure_https() {
  if [ "yes" != "${USE_HTTPS}" ] ; then
    return
  fi

  echo
  echo "Now we're going to fetch a TLS certificate using Let's Encrypt. This is a free"
  echo "service provided by the nonprofit Electronic Frontier Foundation. By using this"
  echo "service, you agree to be bound by the subscriber agreement, found here:"
  echo "  https://letsencrypt.org/repository/#let-s-encrypt-subscriber-agreement"
  echo "If you do not agree, please press ctrl+C now to cancel installation."
  echo

  echo "You must provide an email address, which will be shared with Let's Encrypt."
  ACME_EMAIL="$(prompt "Your email address for Let's Encrypt:" "${SANDCATS_REGISTRATION_EMAIL:-}")"

  $DIR/sandstorm create-acme-account "$ACME_EMAIL" --accept-terms ||
      fail "E_CREATE_ACME_ACCOUNT" "Failed to create Let's Encrypt account."

  echo "Your Let's Encrypt account has been created. Now we'll fetch a certificate!"
  $DIR/sandstorm renew-certificate ||
      fail "E_FETCH_CERTIFICATE" "Failed to fetch certificate."
}

# Now that the steps exist as functions, run them in an order that
# would result in a working install.
handle_args "$@"
set_umask
assert_on_terminal
assert_linux_x86_64
assert_usable_kernel
detect_current_uid
assert_dependencies
assert_valid_bundle_file
detect_init_system
choose_install_mode
maybe_enable_userns_sysctl
choose_external_or_internal
choose_install_dir
choose_smtp_port
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
generate_admin_token
set_permissions
install_sandstorm_symlinks
ask_about_starting_at_boot
configure_start_at_boot_if_desired
wait_for_server_bind_to_its_port
configure_https
print_success
}

# Now that we know the whole script has downloaded, run it.
_ "$0" "$@"

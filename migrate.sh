#! /bin/bash

# This script updates your Sandstorm.io server to the new version
# built by the Sandstorm Community project. This migration script
# will download the latest release of the community version, then
# update your Sandstorm instance and migrate the database to a
# newer version of MongoDB.
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

USE_DEFAULTS="no"
DEFAULT_UPDATE_CHANNEL="dev"

# Allow the environment to override curl's User-Agent parameter. We
# use this to distinguish probably-actual-users installing Sandstorm
# from the automated test suite, which invokes the install script with
# this environment variable set.
CURL_USER_AGENT="${CURL_USER_AGENT:-sandstorm-migrate-script}"

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
      local BEARER_TOKEN="4-Og3Ty2SPmpkZGnVc_8hnBGXK0JBBXDeBn_55FWixJ"
      local API_ENDPOINT="https://alpha-api-df09d5faefd551337b59659de8ae7207.sandstorm.io"
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

usage() {
  echo "usage: $SCRIPT_NAME [<bundle>]" >&2
  echo "If <bundle> is provided, it must be the name of a Sandstorm bundle file," >&2
  echo "like 'sandstorm-123.tar.xz', which will be installed. Otherwise, the script" >&2
  echo "downloads a bundle from the internet via HTTPS." >&2
  exit 1
}

handle_args() {
  SCRIPT_NAME=$1
  shift

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
    # Probably ran like "curl https://install.sandstorm.org/migrate.sh | bash"
    echo "Re-running script as root..."

    exec sudo bash -euo pipefail -c "curl -fs -A $CURL_USER_AGENT https://install.sandstorm.org/migrate.sh | $ENVVARS bash"
  elif [ "$(basename $SCRIPT_NAME)" == migrate.sh ] && [ -e "$0" ]; then
    # Probably ran like "bash migrate.sh" or "./migrate.sh".
    echo "Re-running script as root..."
    if [ ${#ORIGINAL_ARGS[@]} = 0 ]; then
      exec sudo $ENVVARS bash "$SCRIPT_NAME"
    else
      exec sudo $ENVVARS bash "$SCRIPT_NAME" "${ORIGINAL_ARGS[@]}"
    fi
  fi

  # Don't know how to run the script. Let the user figure it out.
  REPORT=no fail "E_CANT_SWITCH_TO_ROOT" "ERROR: This script could not detect its own filename, so could not switch to root. \
Please download a copy and name it 'migrate.sh' and run that as root, perhaps using sudo. \
Try this command:

curl https://install.sandstorm.org/migrate.sh > migrate.sh && sudo bash migrate.sh"
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

assert_dependencies() {
  if [ -z "${BUNDLE_FILE:-}" ]; then
    which curl > /dev/null || fail "E_CURL_MISSING" "Please install curl(1). Sandstorm uses it to download updates."
  fi

  which tar > /dev/null || fail "E_TAR_MISSING" "Please install tar(1)."
  which xz > /dev/null || fail "E_XZ_MISSING" "Please install xz(1). (Package may be called 'xz-utils'.)"
}

assert_sandstorm_installed() {
  if ! which sandstorm > /dev/null 2>&1; then
    fail "E_SANDSTORM_NOT_INSTALLED" \
      "Sandstorm does not appear to be installed on this system. This script migrates an existing Sandstorm installation and cannot be run on a system without Sandstorm."
  fi
}

assert_running_as_root() {
  if [ "$(id -u)" != "0" ]; then
    rerun_script_as_root
  fi
}

assert_enough_disk_space() {
  local SANDSTORM_CONF="${SANDSTORM_CONF:-/opt/sandstorm/sandstorm.conf}"
  local SANDSTORM_DIR
  SANDSTORM_DIR=$(dirname "$SANDSTORM_CONF")

  # df -k reports available space in 1KB blocks; convert to GB for the comparison.
  local AVAILABLE_KB
  AVAILABLE_KB=$(df -k "$SANDSTORM_DIR" | awk 'NR==2 {print $4}')

  local REQUIRED_KB=$((1024 * 1024))  # 1 GB in KB

  if [ "$AVAILABLE_KB" -lt "$REQUIRED_KB" ]; then
    local AVAILABLE_MB=$(( AVAILABLE_KB / 1024 ))
    fail "E_INSUFFICIENT_DISK_SPACE" \
      "Insufficient disk space on the Sandstorm volume ($SANDSTORM_DIR).
Required:  1024 MB
Available: ${AVAILABLE_MB} MB

Please free up disk space before running this migration."
  fi
}

assert_user_has_backed_up() {
  echo ""
  echo "*** IMPORTANT: DATABASE UPGRADE WARNING ***"
  echo ""
  echo "This migration will upgrade your Sandstorm database to a newer version of MongoDB."
  echo "This process is NOT easily reversible. Before proceeding, you should create a full"
  echo "backup of your Sandstorm data directory (typically /opt/sandstorm)."
  echo ""
  echo "To back up your Sandstorm installation, run:"
  echo ""
  echo "  sudo sandstorm stop"
  echo "  sudo cp -a /opt/sandstorm /opt/sandstorm.bak"
  echo "  sudo sandstorm start"
  echo ""
  echo "Type exactly: I have backed up Sandstorm"
  echo ""

  local CONFIRMATION
  if [ "yes" = "$USE_DEFAULTS" ]; then
    CONFIRMATION="I have backed up Sandstorm"
  else
    echo -en '\e[1m' >&3
    echo -n "Confirmation: " >&3
    echo -en '\e[0m' >&3
    read -u 3 CONFIRMATION
  fi

  if [ "$CONFIRMATION" != "I have backed up Sandstorm" ]; then
    REPORT=no fail "E_NO_BACKUP_CONFIRMED" \
      "You must back up your Sandstorm installation before running this migration. Aborting."
  fi
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

download_latest_bundle_if_needed() {
  if [ -n "${BUNDLE_FILE:-}" ]; then
    return
  fi

  echo "Finding latest build for $DEFAULT_UPDATE_CHANNEL channel..."
  BUILD="$(curl -A "$CURL_USER_AGENT" -fs "https://install.sandstorm.org/$DEFAULT_UPDATE_CHANNEL?from=0&type=migrate")"

  if [[ ! "$BUILD" =~ ^[0-9]+$ ]]; then
    fail "E_INVALID_BUILD_NUM" "Server returned invalid build number: $BUILD"
  fi

  BUNDLE_FILE="sandstorm-${BUILD}.tar.xz"

  if [ -e "$BUNDLE_FILE" ]; then
    echo "$BUNDLE_FILE is already present. Should I use it or re-download?"
    if prompt-yesno "Use existing copy?" yes; then
      return
    fi
  fi

  WORK_DIR="$(mktemp -d ./sandstorm-installer.XXXXXXXXXX)"
  local URL="https://dl.sandstorm.org/sandstorm-$BUILD.tar.xz"
  echo "Downloading: $URL"
  retryable_curl "$URL" "$WORK_DIR/sandstorm-$BUILD.tar.xz"
  retryable_curl "$URL.sig" "$WORK_DIR/sandstorm-$BUILD.tar.xz.sig"

  if which gpg > /dev/null; then
    export GNUPGHOME="$WORK_DIR/.gnupg"
    mkdir -m 0700 -p "$GNUPGHOME"
    gpg --dearmor > "$WORK_DIR/sandstorm-keyring.gpg" << __EOF__
-----BEGIN PGP PUBLIC KEY BLOCK-----

mQINBGovGbIBEADFSCXg9ArEZ7lPyXGTvcilX3TaGJDWzAf497GbdAxtAMptkzIL
9Adsg1NYS6BNz+qaLJ1JW+K6qj1YOr7W8TrGvG0R8um1ApPz9IsPRKEgu3X9crno
+roVj/tTzEjMu8yB+j0ir2AP9tMiaKj0hm8qibrZ+yOjv0cTUeMn2cVwm168JN2a
1P2byMn03GOHw3R3myy35kbkbesE2+27biy0p2ti8AVLx4NzTkm/JmSCeAxBrnzM
Ng+B7VOtwH4r6QkPPPZCUaFykKePr88XVy4fDVI3JYJyn8h1l9698/ZWvlqeBJw0
BExVwlStRVPXlQ0lJ+2EzVFmpr8gvIuZLl1Xi0Lvj+CQZlqkXVLY33gee9sCpzYb
i40j9zxWKxCG7XCpb6FakByAu2pMowZUHT7w0MTWucMrRoy3h272KOz9Y+5bPlnM
xyLqGPEtryloBj2ZDq7uzA2aOwSG9CeqiPUtQ0ebm58VdBj5R2YcOvMlKtv5mQ2t
hQpeSdM9kNzzM+WNskvhS1eYq9WdIaSWA3MbNo1AjxjaCJPtpGg+OKWljOrHqoMB
aKjKl2ONY5KxjeGWquZJtEwWRob2SiN6nU3ulibl3UycoscUQ23zZvedaYnWMS1I
scNbm6bOpGXTGv69qw570CUs91bbEillegXUnP2E3pbYqlSsIczNGrTGJQARAQAB
tDRTYW5kc3Rvcm0ub3JnIFJlbGVhc2UgS2V5LTEgPHNlY3VyaXR5QHNhbmRzdG9y
bS5vcmc+iQJUBBMBCgA+FiEEf3gZ+Qt+gQ8mz4ufpzMibHCR7aIFAmovGbICGwMF
CQWjmoAFCwkIBwIGFQoJCAsCBBYCAwECHgECF4AACgkQpzMibHCR7aJlexAAnhVj
gm1nYjOf/dnlRzLi6EUCNH5gJePFtk+yxYcUOBD1U2nLrAF1rTj+ZNeDckkegtuf
Mseln4WR7oxoxBAka5h81FqI8VYvfsjwkqIiqR61SPP3qxsVV2S5m1yMpmVwg0dZ
C5KKt2ey+5o4n2sLDQcBF9S/F+npDvFl9Ft4VfH/mAUbgudN6pvtoWfHDkCeBtrj
M0Gx68vwttcD+c+6rJuaxGr0ZKGIbAzqxjT0LEngZ30kNywrnat4cQTNEAeEPyuN
Nf47FTPQbGD3k0y13qbyAdzN9HmPHyWQWfkQlAh0A86n8DCiq3LuebHp6JjhkdCz
YHqoiUchFzHyL6y5imWvXEdiPVCuY3iPActqnGqWgmhUL8fV60nu8MqYq8pApCEL
oS+C5pSjbG4BZK8fNG0U4Fi0/3/0Cmm3Y1vELK6duXZjLD6QPBFcHn/ORGS64amN
zsHlchOp0vZTfvyvUYtQ+obls0WEquQMC3iClNwvVydCsn/1OPsqN2pd1UmdIw5q
uqfkYrpjytoy/stBSPFUac3wS/rlevfasnEZ0epsjvW73rQBZamJSstxKj56EoFy
ZHQUcWfB77GxCjnKKdov98ZKj/SAJ1aXVVsYTcmFqwQai4oEi4BwPmu777F2Z4rT
T6l6qL9Pd7niH+wIsXCIOO7x2KDQFVhy/f9dVve5Ag0Eai8ZsgEQANsZ/CbcwxTO
g1O6GgViTFzaxt6t6Fft+rM1kBbzRI9RJmkt6VW+sCsT2Du42qKqwv+Qd1PaO+s8
gDfRnxl0TgVVFEb6/Ey+urFYAvL8nKTvjV2yKUpRk9bqZQo06mtkHpGm5UJc/MYG
adoxYprx4E+0JOyp7IE6Ci3W/6frcApeGoV2bhzXjKAT8n5tOq6ieS3Z8XRrCaxi
xPocFNjg2jF4EcGEg2sxJstjqPJxFqnrIaEkEVp0rH+YRqODZJ6WNZfCno6A81WF
3HQIjPe5Ai+9rx+ZmNmedl6++j3KtsxDCZL2LvOXhs6WyagaS4FKKP6SZ7EsAtKD
csGwBdGjQ04v3Jy6d79G7Td7rH5m12LTtiG6YxvkPXKjPDzbuarIRZttTh76MQXE
U/Zo8UH50CMF64NLjNBfO5nwqPSH/MVNau6zLuO69LRUpnqvlkTZM17yPurbw0fJ
frMniC/lTWJBdXXaLO81LmEAT/543O2jW/Q97Nb2+evqcOjqEEuFou1CvflmAWke
pNYDZimDF9+3FRo3dsg6+G323WPgkttKwksGNnDGcdNmIzh/xbfAtjFR+Ut0j2mw
gYIg8oThtZ2iz9x+ui9+zyw+oO4121zabdOlkUm+0pR/zgaVRdNs4lszDkey8DRl
07irjaqUiCFKGBso3ErBsN9n3ifAV8m5ABEBAAGJAjwEGAEKACYWIQR/eBn5C36B
DybPi5+nMyJscJHtogUCai8ZsgIbDAUJBaOagAAKCRCnMyJscJHtoiGKD/9iljpP
c4M/SrULaHEM2u5Hr0WF89OMsQkvvz5Jwh1N8I4D4vBwzeCv0v3sav9lKAq34E5q
Rb+3iLzAsgHP6GCdMtUVNPGqBjc19qSw8bUdmi03S3TWJx2RQRSQ5GfM+INXpLCG
7hfGOR+my+LjW9plcMdCJDc7KbpacSgEfCN5DH8SB66gb/SQXFHgBC6poqIACTXr
4ImMh11e19ZJuBz6AZxq1Cgb7GSncQj89LZaQusQ85MFxDPsW1K15dMvocdRA529
aoqMK+gev4Vjihu9mnhmPd8HLgRwXRR/VYSnTT95cHHxlNadUIMrFW8qxGFCHRxg
eW0TbEWM6lc4axAO7yB4ZmVYLZ0BAykCdj07qanbCsYzu8+xvx/vdaHAjn5vbUl9
pZnkcasZXgK/oRJPwgphMHqbIYDALx0hyi0FoEO0DblQ/RTBI4SpkVgAoDjteDMn
soVrD5psEI7YTUhTdmBdNhmnRd1oX6YBxnPikSdRw5Bis89kGNswKISlxxZvcWMK
sRAA4LtpaD8Rd+bvayEMhoX+IIdOWOAWeIZPs678nZXGAEEmgJ4aVp019/Dyl/2T
DLbqoo/SuTaYlX04symC/8sG8xEYOLfFgxlRb1ODCUzkAaFB0X3Y0VzHHh0d6CdM
HnMvCadPOefOlCvG/TI2AnfmkxuwWUcDt3AR7g==
=K6RJ
-----END PGP PUBLIC KEY BLOCK-----
__EOF__

    if gpg --no-default-keyring --keyring "$WORK_DIR/sandstorm-keyring.gpg" --status-fd 1 \
        --verify "$WORK_DIR/sandstorm-$BUILD.tar.xz"{.sig,} 2>/dev/null | \
        grep -q '^\[GNUPG:\] VALIDSIG 7F7819F90B7E810F26CF8B9FA733226C7091EDA2 '; then
      echo "GPG signature is valid."
    else
      rm -rf "$WORK_DIR"
      fail "E_INVALID_GPG_SIG" "GPG signature is NOT valid! Please report to security@sandstorm.org immediately!"
    fi

    unset GNUPGHOME
  else
    echo "WARNING: gpg not installed; not verifying signatures (but it's HTTPS so you're probably fine)" >&2
  fi

  mv "$WORK_DIR/sandstorm-$BUILD.tar.xz" "./$BUNDLE_FILE"
  rm -rf "$WORK_DIR"
}

apply_update_and_migrate() {
  local SANDSTORM_CONF="${SANDSTORM_CONF:-/opt/sandstorm/sandstorm.conf}"
  local ORIGINAL_UPDATE_CHANNEL

  # Read the current update channel so we can restore it afterward.
  ORIGINAL_UPDATE_CHANNEL=$(grep '^UPDATE_CHANNEL=' "$SANDSTORM_CONF" | cut -d= -f2)

  echo "Stopping Sandstorm..."
  sandstorm stop

  echo "Setting UPDATE_CHANNEL=none to allow manual bundle update..."
  sed -i 's/^UPDATE_CHANNEL=.*/UPDATE_CHANNEL=none/' "$SANDSTORM_CONF"

  echo "Applying new bundle..."
  sandstorm update "$BUNDLE_FILE"

  echo "Migrating database..."
  sandstorm migrate-mongo

  echo "Restoring UPDATE_CHANNEL to '$ORIGINAL_UPDATE_CHANNEL'..."
  sed -i "s/^UPDATE_CHANNEL=.*/UPDATE_CHANNEL=$ORIGINAL_UPDATE_CHANNEL/" "$SANDSTORM_CONF"

  echo "Starting Sandstorm..."
  sandstorm start
}

print_success() {
  echo ""
  echo "Upgrade complete!"
}

# Now that the steps exist as functions, run them in an order that
# would result in a working install.
handle_args "$@"
assert_on_terminal
assert_dependencies
assert_sandstorm_installed
assert_running_as_root
assert_enough_disk_space
assert_user_has_backed_up
assert_valid_bundle_file
download_latest_bundle_if_needed
apply_update_and_migrate
print_success

}

# Now that we know the whole script has downloaded, run it.
_ "$0" "$@"
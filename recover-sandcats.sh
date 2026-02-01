#!/bin/bash
#
# This script recovers access to a sandcats.io subdomain by generating
# new keys and using the email-based recovery flow.
#
# Usage: ./recover-sandcats.sh [sandstorm-dir]
#
# If sandstorm-dir is not provided, defaults to /opt/sandstorm

set -euo pipefail

SANDSTORM_DIR="${1:-/opt/sandstorm}"
SANDCATS_BASE_DOMAIN="${SANDCATS_BASE_DOMAIN:-sandcats.io}"
SANDCATS_API_BASE="${SANDCATS_API_BASE:-https://sandcats.io}"
CURL_USER_AGENT="${CURL_USER_AGENT:-sandstorm-recover-script}"

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
  echo "*** RECOVERY FAILED ***" >&2
  echo ""
  error "$@"
  echo "" >&2
  exit 1
}

prompt() {
  local VALUE
  echo -en '\e[1m' >&3
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

dotdotdot_curl() {
  echo -n '...' >&2
  curl "$@"
  echo -ne '\r' >&2
}

sandcats_generate_keys() {
  local SANDCATS_DIR="$SANDSTORM_DIR/var/sandcats"

  if [ -f "$SANDCATS_DIR/id_rsa.private_combined" ]; then
    echo "Existing keys found in $SANDCATS_DIR"
    if ! prompt-yesno "Generate new keys? (required for recovery)" "yes"; then
      fail "E_NEED_NEW_KEYS" "Recovery requires generating new keys."
    fi
    # Back up existing keys
    local BACKUP_DIR="$SANDCATS_DIR/backup.$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$BACKUP_DIR"
    mv "$SANDCATS_DIR/id_rsa" "$BACKUP_DIR/" 2>/dev/null || true
    mv "$SANDCATS_DIR/id_rsa.pub" "$BACKUP_DIR/" 2>/dev/null || true
    mv "$SANDCATS_DIR/id_rsa.private_combined" "$BACKUP_DIR/" 2>/dev/null || true
    echo "Backed up existing keys to $BACKUP_DIR"
  fi

  echo -n 'Generating new keys...'

  mkdir -p -m 0700 "$SANDCATS_DIR"
  chmod 0700 "$SANDCATS_DIR"

  openssl \
    req \
    -new \
    -newkey rsa:4096 \
    -days 3650 \
    -nodes \
    -x509 \
    -subj "/C=AU/ST=Some-State/O=Internet Widgits Pty Ltd" \
    -keyout "$SANDCATS_DIR/id_rsa" \
    -out "$SANDCATS_DIR/id_rsa.pub" \
    2>/dev/null

  cat "$SANDCATS_DIR/id_rsa" "$SANDCATS_DIR/id_rsa.pub" > "$SANDCATS_DIR/id_rsa.private_combined"

  chmod 0640 "$SANDCATS_DIR/id_rsa" "$SANDCATS_DIR/id_rsa.pub" "$SANDCATS_DIR/id_rsa.private_combined"

  echo " done."
}

sandcats_recover_domain() {
  local SANDCATS_DIR="$SANDSTORM_DIR/var/sandcats"

  DESIRED_SANDCATS_NAME=$(prompt "What Sandcats subdomain do you want to recover?" "")

  if [ -z "$DESIRED_SANDCATS_NAME" ]; then
    fail "E_NO_SUBDOMAIN" "You must provide a subdomain to recover."
  fi

  # Strip the base domain if provided
  if [[ $DESIRED_SANDCATS_NAME =~ [.] ]]; then
    echo ""
    echo "You entered: $DESIRED_SANDCATS_NAME"
    echo ""
    echo "Please enter just the subdomain part, without any dots."
    echo "For example, if your domain is 'myserver.sandcats.io', just enter 'myserver'."
    echo ""
    sandcats_recover_domain
    return
  fi

  echo "OK. We will send a recovery token to the email address on file."
  if ! prompt-yesno "OK to continue?" "yes"; then
    echo "Aborted."
    exit 0
  fi

  # Send recovery token request
  local LOG_PATH="$SANDCATS_DIR/sendrecoverytoken-log"
  mkdir -p "$SANDCATS_DIR"
  touch "$LOG_PATH"
  chmod 0640 "$LOG_PATH"

  echo "Requesting recovery token..."
  HTTP_STATUS=$(
    dotdotdot_curl \
      --silent \
      --max-time 20 \
      -A "$CURL_USER_AGENT" \
      -X POST \
      --data-urlencode "rawHostname=$DESIRED_SANDCATS_NAME" \
      --output "$LOG_PATH" \
      -w '%{http_code}' \
      -H 'X-Sand: cats' \
      -H "Accept: text/plain" \
      "${SANDCATS_API_BASE}/sendrecoverytoken")

  if [ "200" != "$HTTP_STATUS" ]; then
    error "$(cat "$LOG_PATH")"
    fail "E_SEND_TOKEN_FAILED" "Failed to request recovery token."
  fi

  cat "$LOG_PATH"
  echo ''

  TOKEN=$(prompt "Please enter the token that we sent to you by email." '')

  if [ -z "$TOKEN" ]; then
    fail "E_EMPTY_TOKEN" "Empty tokens are not valid."
  fi

  # Submit recovery token
  LOG_PATH="$SANDCATS_DIR/recover-log"
  touch "$LOG_PATH"
  chmod 0640 "$LOG_PATH"

  echo "Submitting recovery token..."
  HTTP_STATUS=$(
    dotdotdot_curl \
      --silent \
      --max-time 20 \
      -A "$CURL_USER_AGENT" \
      -X POST \
      --data-urlencode "rawHostname=$DESIRED_SANDCATS_NAME" \
      --data-urlencode "recoveryToken=$TOKEN" \
      --output "$LOG_PATH" \
      -w '%{http_code}' \
      -H 'X-Sand: cats' \
      -H "Accept: text/plain" \
      --cert "$SANDCATS_DIR/id_rsa.private_combined" \
      "${SANDCATS_API_BASE}/recover")

  if [ "200" != "$HTTP_STATUS" ]; then
    error "$(cat "$LOG_PATH")"
    fail "E_RECOVER_FAILED" "Failed to recover domain."
  fi

  cat "$LOG_PATH"
  echo ''

  # Update DNS
  LOG_PATH="$SANDCATS_DIR/update-log"
  touch "$LOG_PATH"
  chmod 0640 "$LOG_PATH"

  echo "Updating DNS..."
  HTTP_STATUS=$(
    dotdotdot_curl \
      --silent \
      --max-time 20 \
      -A "$CURL_USER_AGENT" \
      -X POST \
      --data-urlencode "rawHostname=$DESIRED_SANDCATS_NAME" \
      --output "$LOG_PATH" \
      -w '%{http_code}' \
      -H 'X-Sand: cats' \
      -H "Accept: text/plain" \
      --cert "$SANDCATS_DIR/id_rsa.private_combined" \
      "${SANDCATS_API_BASE}/update")

  if [ "200" != "$HTTP_STATUS" ]; then
    error "$(cat "$LOG_PATH")"
    fail "E_UPDATE_FAILED" "Failed to update DNS."
  fi

  cat "$LOG_PATH"
  echo ''

  echo ""
  echo "Congratulations! You have recovered ${DESIRED_SANDCATS_NAME}.${SANDCATS_BASE_DOMAIN}."
  echo "Your credentials are in $SANDCATS_DIR; consider making a backup."
  echo ""
  echo "You may need to restart Sandstorm and/or renew your TLS certificate:"
  echo "  sudo sandstorm restart"
  echo "  sudo sandstorm renew-certificate"
}

main() {
  if [ ! -t 1 ]; then
    fail "E_NO_TTY" "This script is interactive. Please run it on a terminal."
  fi

  # Set up FD 3 for interactive input
  exec 3<&1

  if [ ! -d "$SANDSTORM_DIR" ]; then
    fail "E_NO_DIR" "Sandstorm directory not found: $SANDSTORM_DIR"
  fi

  echo "Sandcats.io Domain Recovery"
  echo "============================"
  echo ""
  echo "This script will help you recover access to a sandcats.io subdomain"
  echo "that you previously registered. You will need access to the email"
  echo "address you used when you registered the domain."
  echo ""

  sandcats_generate_keys
  sandcats_recover_domain
}

main "$@"

#!/bin/sh

set -e

# Get the lando logger
. /helpers/log.sh

# Show the welcome message if this is a first boot
if [ ! -f "/tmp/lando-started" ]; then
  echo ""
  echo ""
  echo ""
  lando_blue     "                         STARTING UP                            "
  echo ""
  lando_pink      "         ██       █████  ███    ██ ██████   ██████             "
  lando_pink      "         ██      ██   ██ ████   ██ ██   ██ ██    ██            "
  lando_pink      "         ██      ███████ ██ ██  ██ ██   ██ ██    ██            "
  lando_pink      "         ██      ██   ██ ██  ██ ██ ██   ██ ██    ██            "
  lando_pink      "         ███████ ██   ██ ██   ████ ██████   ██████             "
  echo ""
  lando_blue      "       The best local development tool in the galaxy!          "
  echo ""
  echo ""
  lando_green     "==============================================================="
  echo ""
  echo ""
  touch /tmp/lando-started
fi

# Executable all the helpers
if [ -d "/helpers" ]; then
  chmod +x /helpers/* || true
fi;

# Run user perm setup unless explicitly disabled
if [ -f "/helpers/user-perms.sh" ] && [ -z ${LANDO_NO_USER_PERMS+x} ]; then
  /helpers/user-perms.sh
fi;

# Run user load keys if we can, this requires bash right now so not
# all services will get keys, however generally if the service needs the keys
# its going to have bash
#
# TODO: would be awesome to make this POSIX compliant at some point
# if [ -f "/helpers/load-keys.sh" ] && [ -x "$(command -v bash)" ]; then
#   /helpers/load-keys.sh
# fi;

# Run any sh scripts that we've loaded into the mix for autorun unless we've
# explictly disabled
#
# NOTE: these all need to be /bin/sh COMPLIANT, if they arent see the /bash-scripts
#
if [ -d "/scripts" ] && [ -z ${LANDO_NO_SCRIPTS+x} ]; then
  if [ -x "$(command -v run-parts)" ]; then
    run-parts /scripts
  fi

  # Keep this for backwards compat and fallback opts
  chmod +x /scripts/* || true
  find /scripts/ -type f -name "*.sh" -exec {} \;
fi;

# Run any bash scripts that we've loaded into the mix for autorun unless we've
# explictly disabled
if [ -d "/bash-scripts" ] && [ -z ${LANDO_NO_SCRIPTS+x} ]; then
  if [ -x "$(command -v run-parts)" ] && [ -x "$(command -v bash)" ]; then
    run-parts /bash-scripts
  fi
fi

# Run the COMMAND
# @TODO: We should def figure out whether we can get away with running everything through exec at some point
lando_info "Lando handing off to: $@"

# Try to DROP DOWN to another user if we can
if [ ! -z ${LANDO_DROP_USER+x} ]; then
  lando_debug "Running command as ${LANDO_DROP_USER}..."
  su ${LANDO_DROP_USER} -c "$@" || tail -f /dev/null
# Try using EXEC
elif [ ! -z ${LANDO_NEEDS_EXEC+x} ]; then
  lando_debug "Running command with exec..."
  exec "$@" || tail -f /dev/null
# Otherwise just run
else
 "$@" || tail -f /dev/null
fi;

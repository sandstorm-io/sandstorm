#! /bin/bash

# Runs the Sandstorm shell against a local Sandstorm instance.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

(cd "$SCRIPT_DIR/.." && make shell-env)
cd "$SCRIPT_DIR"

if [ $# -gt 0 ]; then
  SANDSTORM_HOME=$1
elif [ -e /etc/init.d/sandstorm ]; then
  eval "$(grep "^DAEMON=" /etc/init.d/sandstorm)"
  SANDSTORM_HOME=$(dirname $DAEMON)
else
  echo "I couldn't find an initscript for Sandstorm. Please pass the directory" >&2
  echo "where Sandstorm is installed as an argument to this script." >&2
  exit 1
fi

. $SANDSTORM_HOME/sandstorm.conf

if [ "$SERVER_USER" != "$USER" ]; then
  echo "Please change your Sandstorm installation to be owned by your own user" >&2
  echo "account. E.g. run as root:" >&2
  echo "  $SANDSTORM_HOME/sandstorm stop" >&2
  echo "  find $SANDSTORM_HOME/var -user $SERVER_USER -exec chown -h $USER {} +" >&2
  echo "  find $SANDSTORM_HOME/var -group $(id -gn $SERVER_USER) -exec chgrp -h $USER {} +" >&2
  echo "  sed -i -e 's/^SERVER_USER=.*$/SERVER_USER=$USER/g' \\" >&2
  echo "      $SANDSTORM_HOME/sandstorm.conf" >&2
  echo "  $SANDSTORM_HOME/sandstorm start" >&2
  exit 1
fi

if ! $SANDSTORM_HOME/sandstorm status >/dev/null 2>&1; then
  echo "Please start Sandstorm and then stop the front-end:"
  echo "  sudo $SANDSTORM_HOME/sandstorm start" >&2
  echo "  sudo $SANDSTORM_HOME/sandstorm stop-fe" >&2
  exit 1
fi

if curl http://localhost:$PORT >/dev/null 2>&1; then
  echo "Please shut down your Sandstorm front-end:" >&2
  echo "  sudo $SANDSTORM_HOME/sandstorm stop-fe" >&2
  exit 1
fi

MONGO_PASSWD=$(<$SANDSTORM_HOME/var/mongo/passwd)

export MAIL_URL
export DDP_DEFAULT_CONNECTION_URL
export MONGO_URL="mongodb://sandstorm:$MONGO_PASSWD@127.0.0.1:$MONGO_PORT/meteor?authSource=admin"
export MONGO_OPLOG_URL="mongodb://sandstorm:$MONGO_PASSWD@127.0.0.1:$MONGO_PORT/local?authSource=admin"
export ROOT_URL=$BASE_URL

SETTINGS=$(mktemp)

cat > $SETTINGS << __EOF__
{
  "public": {
    "buildstamp": "[local dev front-end]",
    "allowDemoAccounts": true,
    "allowDevAccounts": true,
    "allowUninvited": ${ALLOW_UNINVITED:-false},
    "isTesting": true,
    "wildcardHost": "$WILDCARD_HOST",
    "quotaEnabled": ${QUOTA_ENABLED:-false},
    "stripePublicKey": "${STRIPE_PUBLIC_KEY:-}"
  },
  "home": "$SANDSTORM_HOME",
  "stripeKey": "${STRIPE_KEY:-}"
}
__EOF__

# Work-around for problem where Meteor's bundled npm prefers the system gyp
# over its own bundled version, and the system gyp doesn't work.
export PYTHONPATH=$("$SCRIPT_DIR/../find-meteor-dev-bundle.sh")/lib/node_modules/npm/node_modules/node-gyp/gyp/pylib

exec meteor run -p $PORT --settings $SETTINGS

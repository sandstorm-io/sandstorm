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

# If HTTPS_PORT is specified, then probably the BASE_URL contains HTTPS_PORT
# as well, and run-dev.sh does not know how to listen on HTTPS, so tell the
# user to disable that.
if [ -n "${HTTPS_PORT:-}" ] ; then
  echo "Please remove the HTTPS_PORT= line in your Sandstorm configuration" >&2
  echo "since run-dev.sh does not support HTTPS." >&2
fi

# If PORT specifies two ports to listen on, this script only listens on the
# first, since it calls Meteor directly, and Meteor has no ability to listen
# on multiple ports.
if [[ "${PORT:-}" =~ ^(.*?), ]] ; then
  PORT=${BASH_REMATCH[1]} >&2
fi

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

BIND_IP=${BIND_IP:-127.0.0.1}

if curl http://$BIND_IP:$PORT >/dev/null 2>&1; then
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
    "stripePublicKey": "${STRIPE_PUBLIC_KEY:-}",
    "smtpListenPort": ${SMTP_LISTEN_PORT:-30025}
  },
  "home": "$SANDSTORM_HOME",
  "stripeKey": "${STRIPE_KEY:-}",
  "mailchimpListId": "${MAILCHIMP_LIST_ID:-}",
  "mailchimpKey": "${MAILCHIMP_KEY:-}"
}
__EOF__

exec meteor run --port=$BIND_IP:$PORT --settings $SETTINGS

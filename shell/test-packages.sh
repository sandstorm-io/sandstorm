#! /bin/bash

# Runs `meteor test-packages`. The tests run on a fresh isolated Mongo instance.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

(cd "$SCRIPT_DIR/.." && make shell-env)
cd "$SCRIPT_DIR"

SETTINGS=$(mktemp)

cat > $SETTINGS << __EOF__
{
  "public": {
    "buildstamp": "[local dev front-end]",
    "allowDemoAccounts": true,
    "allowDevAccounts": true,
    "allowUninvited": ${ALLOW_UNINVITED:-false},
    "isTesting": true,
    "wildcardHost": "*.local.sandstorm.io"
  }
}
__EOF__

# Work-around for problem where Meteor's bundled npm prefers the system gyp
# over its own bundled version, and the system gyp doesn't work.
export PYTHONPATH=$("$SCRIPT_DIR/../find-meteor-dev-bundle.sh")/lib/node_modules/npm/node_modules/node-gyp/gyp/pylib

exec meteor test-packages --settings $SETTINGS

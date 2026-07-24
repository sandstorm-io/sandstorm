#!/usr/bin/env bash
#
# Exercises a real build-308 installation through the MongoDB 2.6 -> 7.0 and
# Meteor 2.16 -> 3.4.1 upgrade, including a deterministic migration failure and
# restart recovery.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
BUILD_308_URL=https://dl.sandstorm.io/sandstorm-308.tar.xz
BUILD_308_SHA256=f1317754765b11f260a757724b28e92d5318d8b277f970c99662c01bd9291879
GATE_PORT=${SANDSTORM_UPGRADE_GATE_PORT:-9120}
GATE_MONGO_PORT=$((GATE_PORT + 1))
CACHE_DIR="$REPO_ROOT/tmp/release-gates"
OLD_BUNDLE="$CACHE_DIR/sandstorm-308.tar.xz"
CURRENT_BUNDLE=${SANDSTORM_UPGRADE_GATE_BUNDLE:-"$REPO_ROOT/sandstorm-0-fast.tar.xz"}
mkdir -p "$CACHE_DIR"
WORK_DIR=$(mktemp -d "$CACHE_DIR/upgrade-308.XXXXXXXX")
INSTALL_DIR="$WORK_DIR/sandstorm"
STATE_FILE="$WORK_DIR/build-308-state.json"
LOG_FILE="$INSTALL_DIR/var/log/sandstorm.log"

cleanup() {
  if [ -x "$INSTALL_DIR/sandstorm" ]; then
    "$INSTALL_DIR/sandstorm" stop >/dev/null 2>&1 || true
  fi

  if [ -z "${KEEP_RELEASE_GATE_WORKDIR:-}" ]; then
    rm -rf "$WORK_DIR"
  else
    echo "Preserved release-gate work directory: $WORK_DIR"
  fi
}
trap cleanup EXIT

fail() {
  echo "upgrade-from-308: $*" >&2
  exit 1
}

assert_port_free() {
  local port=$1
  if ss -ltnH "sport = :$port" | grep -q .; then
    fail "TCP port $port is already in use; set SANDSTORM_UPGRADE_GATE_PORT"
  fi
}

wait_for_shell() {
  local attempts=${1:-120}
  local i
  for i in $(seq 1 "$attempts"); do
    if curl -sf --max-time 2 -H "Host: local.sandstorm.io:$GATE_PORT" \
        "http://127.0.0.1:$GATE_PORT/apps" >/dev/null; then
      return
    fi

    sleep 1
  done

  tail -n 160 "$LOG_FILE" >&2 || true
  fail "shell did not become ready on port $GATE_PORT"
}

old_mongo_eval() {
  local javascript=$1
  local password
  password=$(cat "$INSTALL_DIR/var/mongo/passwd")
  "$INSTALL_DIR/sandstorm-308/bin/mongo" --quiet --port "$GATE_MONGO_PORT" \
    --username sandstorm --password="$password" --authenticationDatabase admin --eval "$javascript"
}

current_mongo_eval() {
  local javascript=$1
  local password
  password=$(cat "$INSTALL_DIR/var/mongo/passwd")
  "$INSTALL_DIR/latest/bin/mongosh" --quiet --port "$GATE_MONGO_PORT" \
    --username sandstorm --password="$password" --authenticationDatabase admin --eval "$javascript"
}

json_field() {
  node -e \
    'const state = require(process.argv[1]); process.stdout.write(String(state[process.argv[2]]));' \
    "$STATE_FILE" "$1"
}

run_old_profile_test() {
  (
    cd "$REPO_ROOT/tests"
    SANDSTORM_DIR="$INSTALL_DIR" \
    LAUNCH_URL="http://local.sandstorm.io:$GATE_PORT" \
    SANDSTORM_TESTAPP_PATH="$REPO_ROOT/tests/assets/meteor-testapp.spk" \
    EXPECTED_SERVER_RUNTIME= \
    TESTCASE="tests/account-settings.js Test profile changes passing to testapp" \
      npm test
  )
}

run_upgraded_grain_test() {
  (
    cd "$REPO_ROOT/tests"
    SANDSTORM_DIR="$INSTALL_DIR" \
    LAUNCH_URL="http://local.sandstorm.io:$GATE_PORT" \
    UPGRADE_GRAIN_ID="$(json_field grainId)" \
    UPGRADE_DEV_NAME="$(json_field devName)" \
    UPGRADE_PROFILE_NAME="$(json_field profileName)" \
    TESTCASE="tests/release-gate-upgrade.js Existing build-308 grain survives the platform upgrade" \
      npm test
  )
}

assert_port_free "$GATE_PORT"
assert_port_free "$GATE_MONGO_PORT"
test -f "$CURRENT_BUNDLE" || fail "current bundle not found: $CURRENT_BUNDLE"

if [ ! -f "$OLD_BUNDLE" ]; then
  curl -fL "$BUILD_308_URL" -o "$OLD_BUNDLE"
fi
echo "$BUILD_308_SHA256  $OLD_BUNDLE" | sha256sum --check --status ||
  fail "build-308 bundle checksum mismatch"

echo "Installing authentic build 308 into $INSTALL_DIR"
OVERRIDE_SANDSTORM_DEFAULT_DIR="$INSTALL_DIR" \
  "$REPO_ROOT/install.sh" -d -u -p "$GATE_PORT" "$OLD_BUNDLE"
sed -i \
  -e "s/^PORT=.*/PORT=$GATE_PORT/" \
  -e "s/^MONGO_PORT=.*/MONGO_PORT=$GATE_MONGO_PORT/" \
  -e "s|^BASE_URL=.*|BASE_URL=http://local.sandstorm.io:$GATE_PORT|" \
  -e "s|^WILDCARD_HOST=.*|WILDCARD_HOST=*.local.sandstorm.io:$GATE_PORT|" \
  -e "s/^UPDATE_CHANNEL=.*/UPDATE_CHANNEL=none/" \
  "$INSTALL_DIR/sandstorm.conf"
if grep -q "^IS_TESTING=" "$INSTALL_DIR/sandstorm.conf"; then
  sed -i "s/^IS_TESTING=.*/IS_TESTING=true/" "$INSTALL_DIR/sandstorm.conf"
else
  echo "IS_TESTING=true" >> "$INSTALL_DIR/sandstorm.conf"
fi

test ! -e "$INSTALL_DIR/var/mongo/version" ||
  fail "build-308 install was incorrectly marked as MongoDB 7"

"$INSTALL_DIR/sandstorm" start
wait_for_shell
run_old_profile_test

old_mongo_eval '
  var d = db.getSiblingDB("meteor");
  var grain = d.grains.find().sort({lastUsed: -1}).limit(1).next();
  var account = d.users.findOne({_id: grain.userId});
  var credential = d.users.findOne({_id: account.loginCredentials[0].id});
  d.settings.update(
    {_id: "meteor34UpgradeGate"},
    {_id: "meteor34UpgradeGate", value: "build308-preserved"},
    {upsert: true});
  print(JSON.stringify({
    migrations: d.migrations.findOne({_id: "migrations_applied"}).value,
    users: d.users.count(),
    grains: d.grains.count(),
    packages: d.packages.count(),
    grainId: grain._id,
    devName: credential.services.dev.name,
    profileName: account.profile.name,
    oidcUnique: !!d.users.getIndexes().filter(function (idx) {
      return idx.name === "services.oidc.id_1";
    })[0].unique
  }));
' | tail -n 1 > "$STATE_FILE"

node -e '
  const state = require(process.argv[1]);
  if (state.migrations !== 41 || state.users < 2 || state.grains < 1 ||
      state.packages < 1 || state.oidcUnique) {
    throw new Error(`unexpected build-308 state: ${JSON.stringify(state)}`);
  }
' "$STATE_FILE"

echo "Migrating the build-308 database and starting the Meteor 3.4.1 shell"
"$INSTALL_DIR/sandstorm" stop
"$INSTALL_DIR/sandstorm" update "$CURRENT_BUNDLE"
"$INSTALL_DIR/sandstorm" migrate-mongo
test "$(cat "$INSTALL_DIR/var/mongo/version")" = 7 ||
  fail "MongoDB migration did not write version 7"

"$INSTALL_DIR/sandstorm" start
wait_for_shell
if grep -q "IndexKeySpecsConflict" "$LOG_FILE"; then
  fail "OIDC index reconciliation raced eager index creation"
fi

current_mongo_eval '
  const d = db.getSiblingDB("meteor");
  const migration = d.migrations.findOne({_id: "migrations_applied"});
  const marker = d.settings.findOne({_id: "meteor34UpgradeGate"});
  const oidc = d.users.getIndexes().find((idx) => idx.name === "services.oidc.id_1");
  if (!migration || migration.value !== 42 ||
      !marker || marker.value !== "build308-preserved" ||
      d.users.countDocuments() < 2 || d.grains.countDocuments() < 1 ||
      d.packages.countDocuments() < 1 || !oidc || !oidc.unique || !oidc.sparse) {
    throw new Error("post-upgrade database validation failed");
  }
'
run_upgraded_grain_test

echo "Forcing migration 42 to fail before it mutates the database"
current_mongo_eval '
  const d = db.getSiblingDB("meteor");
  d.migrations.updateOne({_id: "migrations_applied"}, {$set: {value: 41}});
  d.users.dropIndex("services.oidc.id_1");
  d.users.createIndex({"services.oidc.id": 1}, {
    name: "services.oidc.id_1", sparse: true
  });
'
"$INSTALL_DIR/sandstorm" stop
echo 42 > "$INSTALL_DIR/var/migration-test-failure"
"$INSTALL_DIR/sandstorm" start

failure_seen=
for _ in $(seq 1 45); do
  if grep -q "Intentional test failure before migration 42" "$LOG_FILE"; then
    failure_seen=yes
    break
  fi
  sleep 1
done
test "$failure_seen" = yes || fail "intentional migration failure was not observed"
if curl -sf --max-time 2 -H "Host: local.sandstorm.io:$GATE_PORT" \
    "http://127.0.0.1:$GATE_PORT/apps" >/dev/null; then
  fail "shell became externally reachable after a migration failure"
fi
current_mongo_eval '
  const d = db.getSiblingDB("meteor");
  const migration = d.migrations.findOne({_id: "migrations_applied"});
  const oidc = d.users.getIndexes().find((idx) => idx.name === "services.oidc.id_1");
  if (!migration || migration.value !== 41 || !oidc || oidc.unique) {
    throw new Error("failed migration changed durable state");
  }
'

echo "Removing the failpoint and verifying explicit restart recovery"
"$INSTALL_DIR/sandstorm" stop
rm "$INSTALL_DIR/var/migration-test-failure"
"$INSTALL_DIR/sandstorm" start
wait_for_shell
current_mongo_eval '
  const d = db.getSiblingDB("meteor");
  const migration = d.migrations.findOne({_id: "migrations_applied"});
  const marker = d.settings.findOne({_id: "meteor34UpgradeGate"});
  const oidc = d.users.getIndexes().find((idx) => idx.name === "services.oidc.id_1");
  if (!migration || migration.value !== 42 ||
      !marker || marker.value !== "build308-preserved" ||
      !oidc || !oidc.unique || !oidc.sparse) {
    throw new Error("migration restart recovery validation failed");
  }
'
run_upgraded_grain_test

echo "Build-308 upgrade and migration failure/restart recovery gate passed."

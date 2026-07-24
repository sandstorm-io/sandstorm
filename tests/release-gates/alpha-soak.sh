#!/usr/bin/env bash
#
# Creates an isolated Sandstorm installation, installs the Meteor test app, and
# continuously checks the shell process, HTTP endpoints, and migration state.
# The default duration is the 48-hour Meteor 3.4.1 release soak.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SOAK_PORT=${SANDSTORM_SOAK_PORT:-9130}
SOAK_MONGO_PORT=$((SOAK_PORT + 1))
SOAK_DURATION_SECONDS=${SANDSTORM_SOAK_DURATION_SECONDS:-172800}
SOAK_INTERVAL_SECONDS=${SANDSTORM_SOAK_INTERVAL_SECONDS:-60}
SOAK_DB_INTERVAL_SECONDS=${SANDSTORM_SOAK_DB_INTERVAL_SECONDS:-3600}
SOAK_ROOT=${SANDSTORM_SOAK_ROOT:-"$REPO_ROOT/tmp/release-gates/alpha-soak"}
INSTALL_DIR="$SOAK_ROOT/sandstorm"
RESULTS_DIR="$SOAK_ROOT/results"
BUNDLE=${SANDSTORM_SOAK_BUNDLE:-"$REPO_ROOT/sandstorm-0-fast.tar.xz"}
TEST_APP=${SANDSTORM_SOAK_TEST_APP:-"$REPO_ROOT/tests/assets/meteor-testapp.spk"}
LOG_FILE="$INSTALL_DIR/var/log/sandstorm.log"
SAMPLES_FILE="$RESULTS_DIR/samples.tsv"
SUMMARY_FILE="$RESULTS_DIR/summary.txt"

fail() {
  echo "alpha-soak: $*" >&2
  exit 1
}

assert_positive_integer() {
  local name=$1
  local value=$2
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || fail "$name must be a positive integer"
}

assert_port_free() {
  local port=$1
  if ss -ltnH "sport = :$port" | grep -q .; then
    fail "TCP port $port is already in use"
  fi
}

wait_for_shell() {
  local i
  for i in $(seq 1 120); do
    if curl -sf --max-time 2 -H "Host: local.sandstorm.io:$SOAK_PORT" \
        "http://127.0.0.1:$SOAK_PORT/apps" >/dev/null; then
      return
    fi

    sleep 1
  done

  tail -n 160 "$LOG_FILE" >&2 || true
  fail "shell did not become ready on port $SOAK_PORT"
}

mongo_eval() {
  local javascript=$1
  local password
  password=$(cat "$INSTALL_DIR/var/mongo/passwd")
  "$INSTALL_DIR/latest/bin/mongosh" --quiet --port "$SOAK_MONGO_PORT" \
    --username sandstorm --password="$password" --authenticationDatabase admin \
    --eval "$javascript"
}

cleanup() {
  local exit_code=$?
  if [ "$exit_code" -ne 0 ] && [ -f "$SUMMARY_FILE" ]; then
    {
      echo "status=failed"
      echo "exit_code=$exit_code"
      echo "failed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    } >> "$SUMMARY_FILE"
  fi

  if [ -x "$INSTALL_DIR/sandstorm" ]; then
    "$INSTALL_DIR/sandstorm" stop >/dev/null 2>&1 || true
  fi
}

assert_positive_integer SANDSTORM_SOAK_DURATION_SECONDS "$SOAK_DURATION_SECONDS"
assert_positive_integer SANDSTORM_SOAK_INTERVAL_SECONDS "$SOAK_INTERVAL_SECONDS"
assert_positive_integer SANDSTORM_SOAK_DB_INTERVAL_SECONDS "$SOAK_DB_INTERVAL_SECONDS"
test -f "$BUNDLE" || fail "bundle not found: $BUNDLE"
test -f "$TEST_APP" || fail "test app not found: $TEST_APP"
test ! -e "$SOAK_ROOT" || fail "soak root already exists: $SOAK_ROOT"
assert_port_free "$SOAK_PORT"
assert_port_free "$SOAK_MONGO_PORT"

mkdir -p "$RESULTS_DIR"
trap cleanup EXIT

OVERRIDE_SANDSTORM_DEFAULT_DIR="$INSTALL_DIR" \
  "$REPO_ROOT/install.sh" -d -u -p "$SOAK_PORT" "$BUNDLE"
sed -i \
  -e "s/^PORT=.*/PORT=$SOAK_PORT/" \
  -e "s/^MONGO_PORT=.*/MONGO_PORT=$SOAK_MONGO_PORT/" \
  -e "s|^BASE_URL=.*|BASE_URL=http://local.sandstorm.io:$SOAK_PORT|" \
  -e "s|^WILDCARD_HOST=.*|WILDCARD_HOST=*.local.sandstorm.io:$SOAK_PORT|" \
  -e "s/^UPDATE_CHANNEL=.*/UPDATE_CHANNEL=none/" \
  "$INSTALL_DIR/sandstorm.conf"
if grep -q "^IS_TESTING=" "$INSTALL_DIR/sandstorm.conf"; then
  sed -i "s/^IS_TESTING=.*/IS_TESTING=true/" "$INSTALL_DIR/sandstorm.conf"
else
  echo "IS_TESTING=true" >> "$INSTALL_DIR/sandstorm.conf"
fi

"$INSTALL_DIR/sandstorm" start
wait_for_shell

# Exercise a real SPK install and the accounts-sandstorm profile bridge before
# beginning the unattended observation window.
(
  cd "$REPO_ROOT/tests"
  SANDSTORM_DIR="$INSTALL_DIR" \
  LAUNCH_URL="http://local.sandstorm.io:$SOAK_PORT" \
  SANDSTORM_TESTAPP_PATH="$TEST_APP" \
  TESTCASE="tests/account-settings.js Test profile changes passing to testapp" \
    npm test
)

start_epoch=$(date +%s)
deadline_epoch=$((start_epoch + SOAK_DURATION_SECONDS))
next_db_check=$start_epoch
server_pid=$(cat "$INSTALL_DIR/var/pid/sandstorm.pid")
bundle_sha256=$(sha256sum "$BUNDLE" | cut -d " " -f 1)
test_app_sha256=$(sha256sum "$TEST_APP" | cut -d " " -f 1)
git_revision=$(git -C "$REPO_ROOT" rev-parse HEAD)

{
  echo "status=running"
  echo "git_revision=$git_revision"
  echo "bundle=$BUNDLE"
  echo "bundle_sha256=$bundle_sha256"
  echo "test_app=$TEST_APP"
  echo "test_app_sha256=$test_app_sha256"
  echo "server_pid=$server_pid"
  echo "started_at=$(date -u -d "@$start_epoch" +%Y-%m-%dT%H:%M:%SZ)"
  echo "expected_completion=$(date -u -d "@$deadline_epoch" +%Y-%m-%dT%H:%M:%SZ)"
  echo "duration_seconds=$SOAK_DURATION_SECONDS"
  echo "interval_seconds=$SOAK_INTERVAL_SECONDS"
} > "$SUMMARY_FILE"
printf "timestamp_utc\tpid\trss_kib\tlog_bytes\tdatabase_check\n" > "$SAMPLES_FILE"

while true; do
  now=$(date +%s)
  if [ "$now" -ge "$deadline_epoch" ]; then
    break
  fi

  kill -0 "$server_pid" 2>/dev/null || fail "Sandstorm process $server_pid exited"
  curl -sf --max-time 5 -H "Host: local.sandstorm.io:$SOAK_PORT" \
    "http://127.0.0.1:$SOAK_PORT/" >/dev/null ||
    fail "root endpoint health check failed"
  curl -sf --max-time 5 -H "Host: local.sandstorm.io:$SOAK_PORT" \
    "http://127.0.0.1:$SOAK_PORT/apps" >/dev/null ||
    fail "apps endpoint health check failed"

  database_check=skipped
  if [ "$now" -ge "$next_db_check" ]; then
    mongo_eval '
      const d = db.getSiblingDB("meteor");
      const migration = d.migrations.findOne({_id: "migrations_applied"});
      const oidc = d.users.getIndexes().find((idx) => idx.name === "services.oidc.id_1");
      if (!migration || migration.value !== 42 ||
          !oidc || !oidc.unique || !oidc.sparse ||
          d.users.countDocuments() < 2 || d.grains.countDocuments() < 1) {
        throw new Error("alpha soak database integrity check failed");
      }
      print("SOAK_DB_OK");
    ' | grep -q SOAK_DB_OK || fail "database integrity check failed"
    database_check=passed
    next_db_check=$((now + SOAK_DB_INTERVAL_SECONDS))
  fi

  rss_kib=$(ps -o rss= -p "$server_pid" | tr -d " ")
  log_bytes=$(stat -c %s "$LOG_FILE")
  printf "%s\t%s\t%s\t%s\t%s\n" \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    "$server_pid" "$rss_kib" "$log_bytes" "$database_check" >> "$SAMPLES_FILE"
  sleep_for=$SOAK_INTERVAL_SECONDS
  remaining=$((deadline_epoch - now))
  if [ "$remaining" -lt "$sleep_for" ]; then
    sleep_for=$remaining
  fi
  sleep "$sleep_for"
done

{
  echo "status=passed"
  echo "completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >> "$SUMMARY_FILE"
echo "Alpha soak passed after ${SOAK_DURATION_SECONDS}s. Results: $RESULTS_DIR"

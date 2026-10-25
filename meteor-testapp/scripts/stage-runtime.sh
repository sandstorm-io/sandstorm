#!/usr/bin/env bash

set -euo pipefail

app_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
repo_dir=$(cd "$app_dir/.." && pwd)
stage_dir="$app_dir/.meteor-spk"
runtime_dir="$stage_dir/runtime"
bundle_dir="$stage_dir/bundle"
package_dirs="$repo_dir/shell/packages"

audit_runtime() {
  local attempt audit_log
  audit_log=$(mktemp)

  # Validate the installed tree locally before consulting npm's advisory
  # service. This keeps an advisory-service outage distinguishable from a
  # malformed or incomplete runtime.
  meteor npm ls --omit=dev --all >/dev/null

  for attempt in 1 2 3; do
    if npm_config_fetch_retries=0 npm_config_fetch_timeout=15000 \
        meteor npm audit --omit=dev --audit-level=high 2>&1 | tee "$audit_log"; then
      rm -f "$audit_log"
      return 0
    fi

    # A completed audit with findings is a real failure, not a transient
    # advisory-service error.
    if grep -q "^# npm audit report" "$audit_log"; then
      rm -f "$audit_log"
      return 1
    fi

    if [ "$attempt" -lt 3 ]; then
      echo "npm audit failed on attempt $attempt; retrying in 5 seconds..." >&2
      sleep 5
    fi
  done

  echo "WARNING: npm's advisory service is unavailable; the locally valid runtime" >&2
  echo "could not be re-audited during this build." >&2
  rm -f "$audit_log"
  return 0
}

rm -rf "$runtime_dir" "$bundle_dir"
mkdir -p "$runtime_dir/bin"

(
  cd "$app_dir"
  METEOR_PACKAGE_DIRS="$package_dirs" meteor npm install
  METEOR_PACKAGE_DIRS="$package_dirs" meteor build --directory "$stage_dir" --server-only
  cd "$bundle_dir/programs/server"
  chmod u+w package.json npm-shrinkwrap.json
  meteor npm pkg set \
    dependencies.underscore=1.13.8 \
    dependencies.node-gyp=12.4.0 \
    dependencies.@mapbox/node-pre-gyp=2.0.3
  meteor npm install --omit=dev --no-audit
  audit_runtime
)

node_path=$(cd "$app_dir" && meteor node -p process.execPath)
expected_version=$(cd "$app_dir" && meteor node -p process.version)
install -m 0755 "$node_path" "$runtime_dir/bin/node"
install -m 0644 "$app_dir/scripts/start.js" "$runtime_dir/start.js"

# Use the repository's native module, built against the Meteor Node headers,
# rather than the obsolete module bundled with meteor-spk.
mkdir -p "$runtime_dir/node_modules"
install -m 0644 "$repo_dir/deps/node-capnp/src/node-capnp/capnp.js" "$runtime_dir/node_modules/capnp.js"
install -m 0755 "$repo_dir/tmp/node-capnp/capnp.node" "$runtime_dir/node_modules/capnp.node"
# Copy the schemas themselves: packaging src/ directly preserves its capnp
# symlink, whose target does not exist inside the grain.
mkdir -p "$runtime_dir/node_modules/"{capnp,sandstorm}
install -m 0644 "$repo_dir/src/capnp/"*.capnp "$runtime_dir/node_modules/capnp/"
install -m 0644 "$repo_dir/src/sandstorm/"*.capnp "$runtime_dir/node_modules/sandstorm/"
NODE_PATH="$app_dir/capnp" "$node_path" \
  -e 'require(process.argv[1]).importSystem("meteor-testapp.capnp")' \
  "$runtime_dir/node_modules/capnp.js"

while IFS= read -r library; do
  [ -n "$library" ] || continue
  install -D -m 0644 "$library" "$runtime_dir$library"
done < <(ldd "$node_path" "$runtime_dir/node_modules/capnp.node" | awk '
  /=> \/[^ ]+/ { print $3 }
  $1 ~ /^\// && ($2 == "=>" || $2 ~ /^\(/) { print $1 }
')

actual_version=$("$runtime_dir/bin/node" -p process.version)
if [ "$actual_version" != "$expected_version" ]; then
  echo "Staged Node version mismatch: expected $expected_version, got $actual_version" >&2
  exit 1
fi

if ldd "$runtime_dir/bin/node" "$runtime_dir/node_modules/capnp.node" | grep -q "not found"; then
  echo "The staged Node runtime has unresolved shared libraries." >&2
  ldd "$runtime_dir/bin/node" "$runtime_dir/node_modules/capnp.node" >&2
  exit 1
fi

interpreter=$(readelf -l "$runtime_dir/bin/node" |
  sed -n 's/.*Requesting program interpreter: \(.*\)]/\1/p')
if [ -z "$interpreter" ] || [ ! -f "$runtime_dir$interpreter" ]; then
  echo "The staged Node ELF interpreter was not captured: $interpreter" >&2
  exit 1
fi
chmod 0755 "$runtime_dir$interpreter"
if [ ! -x "$runtime_dir$interpreter" ]; then
  echo "The staged Node ELF interpreter is not executable: $interpreter" >&2
  exit 1
fi

echo "Staged Node $expected_version for Meteor 3.4.1 without Mongo at $stage_dir"

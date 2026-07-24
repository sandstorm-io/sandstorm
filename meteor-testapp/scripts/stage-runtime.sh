#!/usr/bin/env bash

set -euo pipefail

app_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
repo_dir=$(cd "$app_dir/.." && pwd)
stage_dir="$app_dir/.meteor-spk"
runtime_dir="$stage_dir/runtime"
bundle_dir="$stage_dir/bundle"
package_dirs="$repo_dir/shell/packages"

rm -rf "$runtime_dir" "$bundle_dir"
mkdir -p "$runtime_dir/bin"

(
  cd "$app_dir"
  METEOR_PACKAGE_DIRS="$package_dirs" meteor npm install
  METEOR_PACKAGE_DIRS="$package_dirs" meteor build --directory "$stage_dir" --server-only
  cd "$bundle_dir/programs/server"
  meteor npm install --omit=dev
)

node_path=$(cd "$app_dir" && meteor node -p process.execPath)
expected_version=$(cd "$app_dir" && meteor node -p process.version)
install -m 0755 "$node_path" "$runtime_dir/bin/node"
install -m 0644 "$app_dir/scripts/start.js" "$runtime_dir/start.js"

while IFS= read -r library; do
  [ -n "$library" ] || continue
  install -D -m 0644 "$library" "$runtime_dir$library"
done < <(ldd "$node_path" | awk '
  /=> \/[^ ]+/ { print $3 }
  /^[[:space:]]*\/[^ ]+/ { print $1 }
')

actual_version=$("$runtime_dir/bin/node" -p process.version)
if [ "$actual_version" != "$expected_version" ]; then
  echo "Staged Node version mismatch: expected $expected_version, got $actual_version" >&2
  exit 1
fi

if ldd "$runtime_dir/bin/node" | grep -q "not found"; then
  echo "The staged Node executable has unresolved shared libraries." >&2
  ldd "$runtime_dir/bin/node" >&2
  exit 1
fi

interpreter=$(readelf -l "$runtime_dir/bin/node" |
  sed -n 's/.*Requesting program interpreter: \(.*\)]/\1/p')
if [ -z "$interpreter" ] || [ ! -f "$runtime_dir$interpreter" ]; then
  echo "The staged Node ELF interpreter was not captured: $interpreter" >&2
  exit 1
fi

echo "Staged Node $expected_version for Meteor 3.4.1 without Mongo at $stage_dir"

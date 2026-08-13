#! /bin/bash

set -euo pipefail

if (grep -r KJ_DBG src/* | egrep -v '/(debug(-test)?|exception)[.]'); then
  echo '*** Error:  There are instances of KJ_DBG in the code.' >&2
  exit 1
fi

make clean

# TODO(soon): Once we have a way to start a beta branch, refuse to do so if there are TODO(soon)s.
# if (egrep -r 'TODO\(soon\)'); then
#   echo '*** Error:  There are release-blocking TODOs in the code.' >&2
#   exit 1
# fi

. branch.conf

if [ $(git rev-parse --abbrev-ref HEAD) = master ]; then
  CHANNEL=dev
elif [ $IS_STABLE = true ]; then
  CHANNEL=stable
else
  CHANNEL=beta
fi

echo "**** Determining next build number for $CHANNEL channel ****"

LAST_BUILD=$(curl -fs https://install.sandstorm.io/$CHANNEL)

if (( LAST_BUILD / 1000 > BRANCH_NUMBER )); then
  echo "ERROR: $CHANNEL has already moved past this branch!" >&2
  echo "  I refuse to replace it with an older branch." >&2
  exit 1
fi

BASE_BUILD=$(( BRANCH_NUMBER * 1000 ))
BUILD=$(( BASE_BUILD > LAST_BUILD ? BASE_BUILD : LAST_BUILD + 1 ))
BUILD_MINOR="$(( $BUILD % 1000 ))"
DISPLAY_VERSION="${BRANCH_NUMBER}.${BUILD_MINOR}"
TAG_NAME="v${DISPLAY_VERSION}"
SIGNING_KEY_ID="$(<keys/release-key-fingerprint)"
LEGACY_SIGNING_KEY_ID="160D2D577518B58D94C9800B63F227499DA8CCBD"

# A detached OpenPGP signature file can contain multiple signature packets. To rotate the release
# key without another manual update, temporarily list both the old and new signing keys here. Old
# installations will accept the old signature while the bridge release installs the new trust root.
SIGNING_KEY_IDS=(
  "$SIGNING_KEY_ID"
)

sign-release-file() {
  local input="$1"
  local output="$input.sig"
  local signature_dir
  signature_dir="$(mktemp -d ./tmp/release-signatures.XXXXXXXX)"
  local index=0

  rm -f "$output"
  for key_id in "${SIGNING_KEY_IDS[@]}"; do
    gpg --batch --no-armor --local-user "$key_id" --digest-algo SHA512 --detach-sig \
        --output "$signature_dir/$index.sig" "$input"
    index=$((index + 1))
  done

  for signature in "$signature_dir"/*.sig; do
    cat "$signature" >> "$output"
  done
  rm -rf "$signature_dir"
}

check-release-trust-root() {
  if [[ ! "$SIGNING_KEY_ID" =~ ^([0-9A-F]{40}|[0-9A-F]{64})$ ]]; then
    echo "Invalid release-key-fingerprint: expected a full, uppercase OpenPGP fingerprint." >&2
    exit 1
  fi

  # Build 309 deliberately requires a manual transition to a new OpenPGP trust root. Never let a
  # release proceed with the legacy key merely because the key-rotation files were not updated.
  if [[ "$SIGNING_KEY_ID" == "$LEGACY_SIGNING_KEY_ID" ]]; then
    echo "Refusing to release with the legacy OpenPGP key. Install the rotated release key first." >&2
    exit 1
  fi

  if ! grep -Fq "[GNUPG:] VALIDSIG $SIGNING_KEY_ID " install.sh; then
    echo "install.sh does not pin the release-key-fingerprint key." >&2
    exit 1
  fi

  local check_home key_listing installer_key_listing
  check_home="$(mktemp -d ./tmp/release-keyring-check.XXXXXXXX)"
  if ! key_listing="$(gpg --batch --no-options --homedir "$check_home" --no-default-keyring \
      --keyring "$PWD/keys/release-keyring.gpg" --with-colons --fingerprint \
      --list-keys "$SIGNING_KEY_ID")"; then
    rm -rf "$check_home"
    echo "The release key is not readable from keys/release-keyring.gpg." >&2
    exit 1
  fi
  if ! grep -q "^fpr:::::::::$SIGNING_KEY_ID:$" <<< "$key_listing"; then
    rm -rf "$check_home"
    echo "keys/release-keyring.gpg does not contain the release-key-fingerprint key." >&2
    exit 1
  fi

  if ! sed -n '/^-----BEGIN PGP PUBLIC KEY BLOCK-----$/,/^-----END PGP PUBLIC KEY BLOCK-----$/p' \
      install.sh | gpg --batch --no-options --homedir "$check_home" --dearmor \
      --output "$check_home/installer-keyring.gpg"; then
    rm -rf "$check_home"
    echo "Could not read the OpenPGP public key embedded in install.sh." >&2
    exit 1
  fi
  if ! installer_key_listing="$(gpg --batch --no-options --homedir "$check_home" \
      --no-default-keyring --keyring "$PWD/$check_home/installer-keyring.gpg" --with-colons \
      --fingerprint --list-keys "$SIGNING_KEY_ID")"; then
    rm -rf "$check_home"
    echo "install.sh does not embed the release-key-fingerprint public key." >&2
    exit 1
  fi
  rm -rf "$check_home"

  if ! grep -q "^fpr:::::::::$SIGNING_KEY_ID:$" <<< "$installer_key_listing"; then
    echo "install.sh does not embed the release-key-fingerprint public key." >&2
    exit 1
  fi
}

check-release-trust-root

# Verify that the changelog has been updated.
EXPECTED_CHANGELOG="### $TAG_NAME ($(date '+%Y-%m-%d'))"
if [[ "$(head -n 1 CHANGELOG.md)" != "$EXPECTED_CHANGELOG"* ]]; then
  echo "Changelog not updated. First line should be:" >&2
  echo "$EXPECTED_CHANGELOG" >&2
  exit 1
fi

# The tarball stores the version number as an integer, e.g. 75 for
# build 75 within branch 0, or 2121 for build 121 within branch 2, so
# that the Sandstorm auto-updater can avoid having complicated
# version-comparison logic.
TARBALL=sandstorm-$BUILD.tar.xz

echo "**** Building build $BUILD ****"

make BUILD=$BUILD

echo "**** Tagging this commit ****"

# The git tag stores the version number as a normal-looking version
# number, like 0.75 for build 75 within branch 0, or 2.121 for build
# 121 within branch 2.

GIT_REVISION="$(<bundle/git-revision)"
git tag -u $SIGNING_KEY_ID "$TAG_NAME" "$GIT_REVISION" -m "Release Sandstorm ${DISPLAY_VERSION}"
git push origin "$TAG_NAME"

# Remember to push it to master too...
git push origin master

echo "**** Pushing build $BUILD ****"

rm -f "$TARBALL.sig" install.sh.sig

# Sign the tarball and the install script. Note that we don't sign the channel build number because
# it wouldn't accomplish anything: If an attacker wanted to provide an old number, they could
# provide the old signature to match. If an attacker provided a number that hasn't been used
# before, they would not be able to provide a matching package because no such signed package
# exists.
sign-release-file "$TARBALL"
sign-release-file install.sh

echo $BUILD > tmp/$CHANNEL
gce-ss copy-files $TARBALL alpha2:/var/www/dl.sandstorm.io
gce-ss copy-files $TARBALL.sig alpha2:/var/www/dl.sandstorm.io
gce-ss copy-files tmp/$CHANNEL alpha2:/var/www/install.sandstorm.io
gce-ss copy-files install.sh alpha2:/var/www/install.sandstorm.io
gce-ss copy-files install.sh.sig alpha2:/var/www/install.sandstorm.io

gce-ss ssh alpha2 --command 'sudo sandstorm update dev'

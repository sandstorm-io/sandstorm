#!/bin/bash
#
# This script will run `mkdocs` on the Sandstorm documentation
# directory, and set up a directory tree in the following
# fashion.
#
# - /: HTML redirect to /en/latest/
#
# - /en/latest/: Contains a copy of the current documentation, built
#   with mkdocs.
#
# This gives us room to store other languages and old versions of the
# docs in a future version of this script.

set -euo pipefail

# Borrow some I/O functions from install.sh.
error() {
  if [ $# != 0 ]; then
    echo -en '\e[0;31m' >&2
    echo "$@" | (fold -s || cat) >&2
    echo -en '\e[0m' >&2
  fi
}

fail() {
  error "$@"
  echo "*** DOCS GENERATION FAILED ***" >&2
  exit 1
}


# Main code for this script.

assert_dependencies() {
  which mkdocs >/dev/null || fail "You must install mkdocs before using this script."
}

handle_args() {
  # Set default value.
  PUSH_AFTER_GENERATE="no"

  while getopts "d:p" opt; do
    case $opt in
      d)
        OUTPUT_DIR="$OPTARG"
        ;;
      p)
        PUSH_AFTER_GENERATE="yes"
        ;;
      *)
        usage
        ;;
    esac
  done

  # If the user did not set OUTPUT_DIR, then we create a temporary
  # directory on the user's behalf. This script will not clean that
  # up, but it will print the directory name.
  if [ -z "${OUTPUT_DIR:-}" ] ; then
    OUTPUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/docs-$(date -I).XXXXXXXXXX")"
    echo "Generating docs in $OUTPUT_DIR"
  fi
}

usage() {
  echo "Generate (and optionally push to git) documentation for Sandstorm." >&2
  echo "" >&2
  echo "usage: $0 [-d directoryname] [-p]" >&2
  echo 'If -d and argument is specified, generate the docs to that directory. Else, use a directory with random name.'
  echo 'If -p is specified, run "git push" from that directory once generation is complete.' >&2
  exit 1
}

create_index_page() {
  # The / page contains a HTTP META-EQUIV pseudo-redirect.
  #
  # Sorry about that.
  echo '<META http-equiv="refresh" content="0;URL=/en/latest/">' > "$OUTPUT_DIR/index.html"
}

run_mkdocs_build() {
  rm -rf "$OUTPUT_DIR/en/latest"
  mkdir -p "$OUTPUT_DIR/en/latest/"
  mkdocs build --site-dir "$OUTPUT_DIR/en/latest/"
  # Clean up after virtualenv mess.
  rm -rf "$OUTPUT_DIR/en/latest/env"
  # Clean up after weird readthedocs theme __init__.py.
  rm -rf "$OUTPUT_DIR/en/latest/__init__.py" "$OUTPUT_DIR/en/latest/__init__.pyc"
}

git_push_if_desired() {
  if [ "${PUSH_AFTER_GENERATE}" != "yes" ] ; then
    return
  fi

  pushd "$OUTPUT_DIR" > /dev/null
  git rm --ignore-unmatch --cached 'en/latest/*'
  git add en/latest
  git add index.html
  git commit -m "Autocommit on $(date -R)"
  git push
  popd > /dev/null
}

generate_redirect_to() {
  echo "<html><head><meta http-equiv='refresh' content='0;url=$1'><link rel='canonical' href='$1'><script type='text/javascript'>window.location.replace('$1' + window.location.hash);</script></head><body><p>Moved to: <a href='$1'>$1</a><br>(Sandstorm Web Publishing doesn't support 301 redirects :(.)</body></html>"
}

add_redirect_hacks() {
  # Add a hack to make sure that a doc that got moved has a redirect stub.
  mkdir -p "$OUTPUT_DIR/en/latest/developing/security-practices"
  generate_redirect_to "https://docs.sandstorm.io/en/latest/using/security-practices/" > "$OUTPUT_DIR/en/latest/developing/security-practices/index.html"
}

assert_dependencies
handle_args "$@"
create_index_page
run_mkdocs_build
add_redirect_hacks
git_push_if_desired

#!/usr/bin/env bash
# NextGCS local SITL installer bootstrap for Linux, macOS, and WSL2.
#
# Intended use (no repository clone needed):
#   curl -fsSL <base-url>/install-sitl.sh | bash
#
# The base URL defaults to the NextGCS repository and can be overridden:
#   NEXTGCS_INSTALL_BASE_URL=https://example.com/nextgcs/scripts \
#     curl -fsSL https://example.com/nextgcs/scripts/install-sitl.sh | bash
#
# Extra arguments are passed to install-sitl.mjs, for example:
#   curl -fsSL <base-url>/install-sitl.sh | bash -s -- --yes --no-start

set -eu

DEFAULT_BASE_URL="https://raw.githubusercontent.com/bradley10/nextgcs-sitl/main"
BASE_URL="${NEXTGCS_INSTALL_BASE_URL:-$DEFAULT_BASE_URL}"
BASE_URL="${BASE_URL%/}"
SCRIPT_URL="$BASE_URL/install-sitl.mjs"

say() {
  printf '%s\n' "$*"
}

fail() {
  message="${1:-The installer could not continue.}"
  shift || true
  printf '\nNextGCS SITL installer could not start: %s\n' "$message" >&2
  if [ "$#" -gt 0 ]; then
    printf '\nWhat to try next:\n' >&2
    for hint in "$@"; do
      printf '  - %s\n' "$hint" >&2
    done
  fi
  printf '\n' >&2
  exit 1
}

# Node.js 20+ is required. Node also runs the WebSocket bridge, so it is not
# optional. Never try to install it silently; print the smallest useful steps.
if ! command -v node >/dev/null 2>&1; then
  fail "Node.js is not installed or not on PATH." \
    "Install Node.js 20 or newer from https://nodejs.org/ (it includes npm)." \
    "macOS with Homebrew: brew install node" \
    "Ubuntu/Debian: curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs" \
    "Then run this command again."
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
case "$NODE_MAJOR" in
  ''|*[!0-9]*) fail "Could not determine the Node.js version (node -v returned nothing)." \
    "Reinstall Node.js 20 or newer from https://nodejs.org/." ;;
esac
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node.js 20 or newer is needed; this is $(node -v 2>/dev/null || echo unknown)." \
    "Install a newer Node.js from https://nodejs.org/ and run this command again."
fi

TMP_ROOT="${TMPDIR:-/tmp}"
TMP_DIR="$(mktemp -d "$TMP_ROOT/nextgcs-sitl.XXXXXX" 2>/dev/null || true)"
if [ -z "${TMP_DIR:-}" ] || [ ! -d "$TMP_DIR" ]; then
  fail "Could not create a temporary folder in $TMP_ROOT." \
    "Set TMPDIR to a writable folder and try again."
fi

cleanup() {
  rm -rf "$TMP_DIR" 2>/dev/null || true
}
trap cleanup EXIT

RUNNER="$TMP_DIR/install-sitl.mjs"

# For a private GitHub repository, raw.githubusercontent.com requires an
# Authorization header. Prefer GITHUB_TOKEN; otherwise reuse an existing GitHub
# CLI login so a private-deployment command stays a one-liner. The token is
# written to a private curl config file instead of the command line so it does
# not appear in process listings.
github_token() {
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    printf '%s' "$GITHUB_TOKEN"
    return
  fi
  if command -v gh >/dev/null 2>&1; then
    gh auth token 2>/dev/null || true
  fi
}
AUTH_CONFIG=""
case "$SCRIPT_URL" in
  https://raw.githubusercontent.com/*|https://github.com/*|https://api.github.com/*)
    GH_TOKEN_VALUE="$(github_token)"
    if [ -n "$GH_TOKEN_VALUE" ]; then
      AUTH_CONFIG="$TMP_DIR/curl-auth.conf"
      (umask 077 && printf 'header = "Authorization: Bearer %s"\n' "$GH_TOKEN_VALUE" > "$AUTH_CONFIG")
    fi
    unset GH_TOKEN_VALUE
    ;;
esac

run_curl() {
  if [ -n "$AUTH_CONFIG" ]; then
    curl --config "$AUTH_CONFIG" "$@"
  else
    curl "$@"
  fi
}

# When this file is run from a checkout, use the sibling script instead of
# downloading. This makes local testing and self-hosting predictable. When the
# file is piped from curl, BASH_SOURCE is empty and the download path is used.
# An explicit NEXTGCS_INSTALL_BASE_URL always wins, so forks and mirrors work
# even from a checkout.
SELF="${BASH_SOURCE[0]:-}"
if [ -n "$SELF" ] && [ -f "$SELF" ] && [ -z "${NEXTGCS_INSTALL_BASE_URL:-}" ]; then
  SELF_DIR="$(CDPATH= cd -- "$(dirname -- "$SELF")" && pwd)"
  if [ -f "$SELF_DIR/install-sitl.mjs" ]; then
    RUNNER="$SELF_DIR/install-sitl.mjs"
  fi
fi

if [ ! -f "$RUNNER" ]; then
  say "Downloading the NextGCS SITL installer..."
  say "  $SCRIPT_URL"

  if command -v curl >/dev/null 2>&1; then
    if run_curl -fsSL --connect-timeout 15 --max-time 180 "$SCRIPT_URL" -o "$RUNNER"; then
      :
    else
      CURL_STATUS=$?
      case "$CURL_STATUS" in
        22)
          fail "The download server returned an HTTP error for install-sitl.mjs." \
            "A 404, 403, or 401 usually means the repository is private or the base URL is wrong." \
            "For a private GitHub repository, sign in with the GitHub CLI (gh auth login), or set GITHUB_TOKEN to a token that can read the repository." \
            "Or host the scripts at a URL you can reach and set NEXTGCS_INSTALL_BASE_URL." \
            "URL: $SCRIPT_URL" ;;
        6|7)
          fail "Could not reach the download server." \
            "Check the internet connection and try again." \
            "If a proxy is required, configure curl to use it, or host the scripts locally and set NEXTGCS_INSTALL_BASE_URL." \
            "URL: $SCRIPT_URL" ;;
        *)
          fail "Could not download install-sitl.mjs (curl exit $CURL_STATUS)." \
            "Check the internet connection and try again." \
            "If you use a fork or a private repository, set NEXTGCS_INSTALL_BASE_URL to a URL you can reach." \
            "URL: $SCRIPT_URL" ;;
      esac
    fi
  elif command -v wget >/dev/null 2>&1; then
    if wget -q --timeout=30 --tries=2 -O "$RUNNER" "$SCRIPT_URL"; then
      :
    else
      WGET_STATUS=$?
      case "$WGET_STATUS" in
        8)
          fail "The download server returned an HTTP error for install-sitl.mjs." \
            "A 404, 403, or 401 usually means the repository is private or the base URL is wrong." \
            "For a private GitHub repository, sign in with the GitHub CLI (gh auth login), or set GITHUB_TOKEN to a token that can read the repository." \
            "Or host the scripts at a URL you can reach and set NEXTGCS_INSTALL_BASE_URL." \
            "URL: $SCRIPT_URL" ;;
        *)
          fail "Could not download install-sitl.mjs (wget exit $WGET_STATUS)." \
            "Check the internet connection and try again." \
            "If you use a fork or a private repository, set NEXTGCS_INSTALL_BASE_URL to a URL you can reach." \
            "URL: $SCRIPT_URL" ;;
      esac
    fi
  else
    fail "Neither curl nor wget is available to download the installer." \
      "Install curl (for example: sudo apt-get install -y curl) and try again." \
      "URL: $SCRIPT_URL"
  fi
fi

if [ ! -s "$RUNNER" ]; then
  fail "The downloaded installer is empty." \
    "Check the internet connection and try again." \
    "URL: $SCRIPT_URL"
fi

node "$RUNNER" "$@"
STATUS=$?
exit "$STATUS"

#!/usr/bin/env bash
# shellcheck shell=bash
# Brace-around-vars (SC2250) and [[ vs [ (SC2292) are pure cosmetics; the
# surrounding code is already explicit, so suppress them globally.
# shellcheck disable=SC2250,SC2292
set -euo pipefail

# ── Constants ───────────────────────────────────────────────────────
OWNER="zaherg"
REPO="bab"
GITHUB_API="https://api.github.com/repos/${OWNER}/${REPO}/releases/latest"
: "${HOME:?HOME is required; use --prefix DIR to install without HOME}"
DEFAULT_PREFIX="${HOME}/.local/bin"

# ── Curl helper ─────────────────────────────────────────────────────
# Centralized download options: fail on HTTP errors, follow redirects,
# retry transient failures, bound connect and total time so a stalled
# connection can't hang the installer.
curl_dl() {
  curl --fail --show-error --location --retry 3 --retry-delay 1 \
    --connect-timeout 10 --max-time 300 "$@"
}

# ── Color helpers ───────────────────────────────────────────────────
if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[0;33m'
  CYAN='\033[0;36m'
  BOLD='\033[1m'
  RESET='\033[0m'
else
  RED='' GREEN='' YELLOW='' CYAN='' BOLD='' RESET=''
fi

info()  { printf "%b%s%b\n" "$CYAN" "$*" "$RESET"; }
ok()    { printf "%b%s%b\n" "$GREEN" "$*" "$RESET"; }
warn()  { printf "%bWARNING: %s%b\n" "$YELLOW" "$*" "$RESET"; }
err()   { printf "%bERROR: %s%b\n" "$RED" "$*" "$RESET" >&2; }
die()   { err "$*"; exit 1; }

usage() {
  cat <<EOF
Bab Installer

Usage:
  curl -fsSL https://raw.githubusercontent.com/${OWNER}/${REPO}/main/scripts/install.sh | bash
  curl -fsSL ... | bash -s -- [OPTIONS]

Options:
  --prefix DIR   Install to DIR instead of ~/.local/bin
  --force        Overwrite existing install (even if Homebrew-managed)
  --no-verify    Skip checksum verification
  --prerelease   Install the latest pre-release (beta, rc, dated) instead of the latest stable
  --help, -h     Show this help message
EOF
}

# ── Parse flags ─────────────────────────────────────────────────────
PREFIX=""
FORCE=0
NO_VERIFY=0
PRERELEASE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --prefix)
      [ -n "${2:-}" ] || die "--prefix requires a directory argument"
      PREFIX="$2"; shift 2 ;;
    --prefix=*)
      PREFIX="${1#--prefix=}"
      [ -n "$PREFIX" ] || die "--prefix requires a non-empty directory argument"
      shift ;;
    --force)
      FORCE=1; shift ;;
    --no-verify)
      NO_VERIFY=1; shift ;;
    --prerelease)
      PRERELEASE=1; shift ;;
    --help|-h)
      usage; exit 0 ;;
    *)
      die "Unknown option: $1. Use --help for usage." ;;
  esac
done

INSTALL_DIR="${PREFIX:-$DEFAULT_PREFIX}"
INSTALL_PATH="${INSTALL_DIR}/bab"

# ── Detect platform ────────────────────────────────────────────────
detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"

  case "$os" in
    Darwin)  PLATFORM="darwin" ;;
    Linux)   PLATFORM="linux"  ;;
    MINGW*|MSYS*|CYGWIN*)
      die "Windows is not supported. Use WSL instead." ;;
    *)
      die "Unsupported operating system: $os" ;;
  esac

  case "$arch" in
    x86_64|amd64) ARCH="x64"   ;;
    aarch64|arm64) ARCH="arm64" ;;
    *)
      die "Unsupported architecture: $arch" ;;
  esac

  info "Detected platform: ${PLATFORM}-${ARCH}"
}

# ── Resolve latest version ─────────────────────────────────────────
resolve_version() {
  if [ "$PRERELEASE" -eq 1 ]; then
    info "Fetching latest pre-release..."
    local response
    # SC2310: function called in || condition intentionally disables
    # set -e for this single call; we exit via die() on failure.
    # shellcheck disable=SC2310
    response="$(curl_dl "https://api.github.com/repos/${OWNER}/${REPO}/releases?per_page=20")" \
      || die "Failed to fetch releases from GitHub. Check your connection."

    if command -v jq >/dev/null 2>&1; then
      VERSION="$(printf '%s' "$response" | jq -r '[.[] | select(.prerelease == true)][0].tag_name // empty')"
    else
      VERSION="$(printf '%s' "$response" \
        | awk '/"tag_name"/{tag=$0} /"prerelease": *true/{pr=1} /}/&&pr{print tag; pr=0; tag=""; exit}' \
        | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"
    fi
    [ -n "$VERSION" ] || die "No pre-release found. Use --prerelease=0 (default) to install the latest stable."
    [[ "$VERSION" =~ ^v?[0-9] ]] || die "Malformed pre-release tag from GitHub: ${VERSION}"
    info "Latest pre-release: ${VERSION}"
  else
    info "Fetching latest release..."
    local response
    # SC2310: see comment above; || handles exit on failure.
    # shellcheck disable=SC2310
    response="$(curl_dl "$GITHUB_API")" \
      || die "Failed to fetch latest release from GitHub. Check your connection."
    if command -v jq >/dev/null 2>&1; then
      VERSION="$(printf '%s' "$response" | jq -r '.tag_name // empty')"
    else
      VERSION="$(printf '%s' "$response" | grep '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"
    fi
    [ -n "$VERSION" ] || die "Could not determine latest version"
    [[ "$VERSION" =~ ^v?[0-9] ]] || die "Malformed release tag from GitHub: ${VERSION}"
    info "Latest version: ${VERSION}"
  fi
}

# ── Fetch and install ──────────────────────────────────────────────
fetch_and_install() {
  local asset="bab-${PLATFORM}-${ARCH}"
  local base_url="https://github.com/${OWNER}/${REPO}/releases/download/${VERSION}"
  local binary_url="${base_url}/${asset}"
  local checksums_url="${base_url}/checksums.sha256"

  TMPDIR_DL="$(mktemp -d)"
  trap cleanup_download EXIT INT TERM

  info "Downloading ${asset}..."
  # SC2310: ||-style error handling is intentional below.
  # shellcheck disable=SC2310
  if ! curl_dl -o "${TMPDIR_DL}/bab" "$binary_url"; then
    if [ -n "$PREFIX" ]; then
      die "Binary download failed for ${binary_url}. Not falling back to Homebrew because --prefix was specified."
    fi
    warn "Binary download failed. Attempting Homebrew fallback..."
    brew_fallback   # never returns; exits 0 or 1
  fi

  if [ "$NO_VERIFY" -eq 1 ]; then
    warn "Skipping checksum verification (--no-verify)"
  else
    info "Downloading checksums..."
    # SC2310: see above.
    # shellcheck disable=SC2310
    if ! curl_dl -o "${TMPDIR_DL}/checksums.sha256" "$checksums_url"; then
      die "Checksum download failed — cannot verify binary integrity. Use --no-verify to skip."
    fi

    verify_checksum "$asset"
  fi

  install_binary
}

cleanup_download() {
  local status=$?
  [ -n "${TMPDIR_DL:-}" ] && rm -rf "$TMPDIR_DL" 2>/dev/null || true
  exit "$status"
}

# ── Verify checksum ─────────────────────────────────────────────────
verify_checksum() {
  local asset="$1"
  info "Verifying checksum..."

  if [ "$PLATFORM" = "darwin" ]; then
    command -v shasum >/dev/null 2>&1 \
      || die "shasum is required for checksum verification"
  else
    command -v sha256sum >/dev/null 2>&1 \
      || die "sha256sum is required for checksum verification"
  fi

  local expected_hash
  expected_hash="$(awk -v asset="$asset" '$2 == asset { print $1 }' "${TMPDIR_DL}/checksums.sha256")"
  [ -n "$expected_hash" ] || die "No checksum found for ${asset} in checksums.sha256"

  # Build a checksums file with the local filename "bab" so the
  # verification tools can locate the downloaded binary.
  printf '%s  bab\n' "$expected_hash" > "${TMPDIR_DL}/check.sha256"

  # Run verification in a subshell to avoid leaking the cd
  (
    cd "$TMPDIR_DL"
    if [ "$PLATFORM" = "darwin" ]; then
      shasum -a 256 -c check.sha256 >/dev/null 2>&1
    else
      sha256sum -c check.sha256 >/dev/null 2>&1
    fi
  ) || die "Checksum verification failed — aborting"

  ok "Checksum verified"
}

# ── Brew fallback ───────────────────────────────────────────────────
brew_fallback() {
  if command -v brew >/dev/null 2>&1; then
    info "Installing via Homebrew..."
    brew install "${OWNER}/tap/${REPO}"
    ok "Installed via Homebrew. To update, run: brew upgrade ${REPO}"
    exit 0
  else
    err "Binary download failed and Homebrew is not available."
    printf "\nManual install options:\n"
    printf "  1. Download from: https://github.com/%s/%s/releases/latest\n" "$OWNER" "$REPO"
    printf "  2. Install Homebrew, then run:\n"
    printf "     brew install %s/tap/%s\n" "$OWNER" "$REPO"
    exit 1
  fi
}

# ── Sudo confirmation ──────────────────────────────────────────────
# When the install dir is not user-writable, we'll need sudo. Confirm
# the exact action unless --force was passed; abort cleanly if not in
# a terminal and not forced.
confirm_sudo() {
  local action="$1"
  if [ "$FORCE" -eq 1 ]; then
    return 0
  fi
  if [ ! -t 0 ]; then
    die "Need sudo to ${action} ${INSTALL_PATH}, but stdin is not interactive. Rerun with --force after reviewing the path."
  fi
  printf "Install with sudo to %s? [y/N] " "$INSTALL_PATH"
  local answer
  read -r answer
  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *) die "Aborted by user" ;;
  esac
}

# ── Install binary ──────────────────────────────────────────────────
install_binary() {
  # Strip macOS quarantine attribute from the downloaded binary
  if [ "$PLATFORM" = "darwin" ]; then
    xattr -d com.apple.quarantine "${TMPDIR_DL}/bab" 2>/dev/null || true
  fi

  # Refuse symlinked destinations so a privileged install can't be
  # redirected to an unexpected location by an attacker-controlled
  # symlink in INSTALL_DIR.
  if [ -L "$INSTALL_PATH" ]; then
    die "${INSTALL_PATH} is a symlink; remove it or pass a different --prefix."
  fi

  # Check for existing Homebrew-managed install (realpath follows
  # the full symlink chain; also check Linuxbrew prefixes)
  if [ -e "$INSTALL_PATH" ] && [ "$FORCE" -eq 0 ]; then
    local resolved
    resolved="$(realpath "$INSTALL_PATH" 2>/dev/null || readlink "$INSTALL_PATH" 2>/dev/null || true)"
    case "$resolved" in
      */Cellar/*|*/Homebrew/*|*/linuxbrew/*)
        warn "Existing Homebrew install detected at ${resolved}. Run 'brew upgrade ${REPO}' instead or use --force to overwrite."
        exit 1
        ;;
      *)
        : # not a Homebrew-managed path; continue with install
        ;;
    esac
  fi

  # Create install directory (with sudo fallback)
  if ! mkdir -p "$INSTALL_DIR" 2>/dev/null; then
    confirm_sudo "create directory ${INSTALL_DIR}"
    info "Elevated permissions required to create ${INSTALL_DIR}"
    sudo mkdir -p "$INSTALL_DIR"
  fi

  chmod +x "${TMPDIR_DL}/bab"

  # Smoke test the downloaded binary before swapping it in. With
  # --no-verify this is the only check we have; with verification on
  # it catches the case where the binary is well-formed but broken.
  if ! "${TMPDIR_DL}/bab" --version >/dev/null 2>&1; then
    die "Downloaded binary failed smoke test (--version did not run). Aborting."
  fi

  # Atomic install: stage inside INSTALL_DIR, then rename into place.
  # Avoids a partial-binary window and keeps the previous bab intact
  # if anything goes wrong before the rename.
  local tmp_target="${INSTALL_DIR}/.bab.tmp.$$"
  local use_sudo=0
  if [ ! -w "$INSTALL_DIR" ]; then
    use_sudo=1
  fi

  if [ "$use_sudo" -eq 1 ]; then
    confirm_sudo "write to ${INSTALL_DIR}"
    info "Elevated permissions required to write to ${INSTALL_DIR}"
    sudo install -m 755 "${TMPDIR_DL}/bab" "$tmp_target"
    sudo mv -f "$tmp_target" "$INSTALL_PATH"
  else
    install -m 755 "${TMPDIR_DL}/bab" "$tmp_target"
    mv -f "$tmp_target" "$INSTALL_PATH"
  fi

  # Strip macOS quarantine attribute (mv can preserve xattrs across the move)
  if [ "$PLATFORM" = "darwin" ]; then
    xattr -d com.apple.quarantine "$INSTALL_PATH" 2>/dev/null || true
  fi

  ok "Installed bab to ${INSTALL_PATH}"

  # PATH check
  check_path

  # Verify installation via the path we just wrote, not $PATH (which
  # may still resolve an older install).
  if [ -x "$INSTALL_PATH" ]; then
    # SC2312: capture the version separately so we don't mask the exit
    # code of the binary's --version.
    # shellcheck disable=SC2312
    info "Installed version: $("$INSTALL_PATH" --version 2>/dev/null || echo 'unknown')"
  fi

  printf "\n%bTo update later, run:%b bab selfupdate\n" "$BOLD" "$RESET"
}

# ── PATH check ──────────────────────────────────────────────────────
check_path() {
  # Split PATH on ':' and compare each entry literally — avoids any
  # glob/pattern expansion of INSTALL_DIR (e.g. if it contains '*').
  local entry IFS=':'
  # Unquoted on purpose: with IFS=':', word-splitting on $PATH gives
  # the individual entries.
  for entry in $PATH; do
    if [ "$entry" = "$INSTALL_DIR" ]; then
      return 0
    fi
  done

  warn "${INSTALL_DIR} is not in your PATH"
  printf "\nAdd it by appending one of the following to your shell profile:\n\n"

  local shell_name
  shell_name="$(basename "${SHELL:-bash}")"
  case "$shell_name" in
    zsh)
      printf "  echo 'export PATH=\"%s:\$PATH\"' >> ~/.zprofile   # login shells\n" "$INSTALL_DIR"
      printf "  echo 'export PATH=\"%s:\$PATH\"' >> ~/.zshrc      # interactive shells\n" "$INSTALL_DIR"
      printf "  source ~/.zshrc\n"
      ;;
    fish)
      printf "  fish_add_path %s\n" "$INSTALL_DIR"
      ;;
    *)
      printf "  echo 'export PATH=\"%s:\$PATH\"' >> ~/.bashrc\n" "$INSTALL_DIR"
      printf "  source ~/.bashrc\n"
      ;;
  esac
  printf "\n"
}

# ── Main ────────────────────────────────────────────────────────────
main() {
  printf "\n%bBab Installer%b\n\n" "$BOLD" "$RESET"
  detect_platform
  resolve_version
  fetch_and_install
}

main

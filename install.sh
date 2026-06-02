#!/usr/bin/env bash
set -euo pipefail

# ── Constants ───────────────────────────────────────────────────────
OWNER="babmcp"
REPO="bab"
GITHUB_API="https://api.github.com/repos/${OWNER}/${REPO}/releases/latest"
DEFAULT_PREFIX="${HOME}/.local/bin"

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
  curl -fsSL https://raw.githubusercontent.com/${OWNER}/${REPO}/main/install.sh | bash
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
    response="$(curl -fsSL "https://api.github.com/repos/${OWNER}/${REPO}/releases?per_page=20")" \
      || die "Failed to fetch releases from GitHub. Check your connection."

    if command -v jq >/dev/null 2>&1; then
      VERSION="$(printf '%s' "$response" | jq -r '[.[] | select(.prerelease == true)][0].tag_name // empty')"
    else
      VERSION="$(printf '%s' "$response" \
        | awk '/"tag_name"/{tag=$0} /"prerelease": *true/{pr=1} /}/&&pr{print tag; pr=0; tag=""; exit}' \
        | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"
    fi
    [ -n "$VERSION" ] || die "No pre-release found. Use --prerelease=0 (default) to install the latest stable."
    info "Latest pre-release: ${VERSION}"
  else
    info "Fetching latest release..."
    local response
    response="$(curl -fsSL "$GITHUB_API")" \
      || die "Failed to fetch latest release from GitHub. Check your connection."
    if command -v jq >/dev/null 2>&1; then
      VERSION="$(printf '%s' "$response" | jq -r '.tag_name')"
    else
      VERSION="$(printf '%s' "$response" | grep '"tag_name"' | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"
    fi
    [ -n "$VERSION" ] || die "Could not determine latest version"
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
  trap 'rm -rf "$TMPDIR_DL"' EXIT

  info "Downloading ${asset}..."
  if ! curl -fSL -o "${TMPDIR_DL}/bab" "$binary_url"; then
    warn "Binary download failed. Attempting Homebrew fallback..."
    brew_fallback
    return
  fi

  if [ "$NO_VERIFY" -eq 1 ]; then
    warn "Skipping checksum verification (--no-verify)"
  else
    info "Downloading checksums..."
    if ! curl -fSL -o "${TMPDIR_DL}/checksums.sha256" "$checksums_url"; then
      die "Checksum download failed — cannot verify binary integrity. Use --no-verify to skip."
    fi

    verify_checksum "$asset"
  fi

  install_binary
}

# ── Verify checksum ─────────────────────────────────────────────────
verify_checksum() {
  local asset="$1"
  info "Verifying checksum..."

  local expected
  expected="$(grep -F " ${asset}" "${TMPDIR_DL}/checksums.sha256" | grep "${asset}$")" \
    || die "No checksum found for ${asset} in checksums.sha256"

  # Write a checksum file with the local filename "bab"
  printf '%s\n' "$expected" | sed "s|${asset}|bab|" > "${TMPDIR_DL}/check.sha256"

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

# ── Install binary ──────────────────────────────────────────────────
install_binary() {
  # Strip macOS quarantine attribute
  if [ "$PLATFORM" = "darwin" ]; then
    xattr -d com.apple.quarantine "${TMPDIR_DL}/bab" 2>/dev/null || true
  fi

  # Check for existing Homebrew-managed install
  if [ -f "$INSTALL_PATH" ] && [ "$FORCE" -eq 0 ]; then
    local resolved
    resolved="$(readlink "$INSTALL_PATH" 2>/dev/null || true)"
    if printf '%s' "$resolved" | grep -q "Cellar"; then
      warn "Existing Homebrew install detected. Run 'brew upgrade ${REPO}' instead or use --force to overwrite."
      exit 1
    fi
  fi

  # Create install directory (with sudo fallback)
  if ! mkdir -p "$INSTALL_DIR" 2>/dev/null; then
    info "Elevated permissions required to create ${INSTALL_DIR}"
    sudo mkdir -p "$INSTALL_DIR"
  fi

  # Make executable and move
  chmod +x "${TMPDIR_DL}/bab"

  if [ -w "$INSTALL_DIR" ]; then
    mv "${TMPDIR_DL}/bab" "$INSTALL_PATH"
  else
    info "Elevated permissions required to write to ${INSTALL_DIR}"
    sudo mv "${TMPDIR_DL}/bab" "$INSTALL_PATH"
  fi

  # Strip macOS quarantine attribute (mv can preserve xattrs across the move)
  if [ "$PLATFORM" = "darwin" ]; then
    xattr -d com.apple.quarantine "$INSTALL_PATH" 2>/dev/null || true
  fi

  ok "Installed bab to ${INSTALL_PATH}"

  # PATH check
  check_path

  # Verify installation
  if command -v bab >/dev/null 2>&1; then
    info "Installed version: $(bab --version 2>/dev/null || echo 'unknown')"
  fi

  printf "\n%bTo update later, run:%b bab selfupdate\n" "$BOLD" "$RESET"
}

# ── PATH check ──────────────────────────────────────────────────────
check_path() {
  case ":${PATH}:" in
    *":${INSTALL_DIR}:"*) return ;;
  esac

  warn "${INSTALL_DIR} is not in your PATH"
  printf "\nAdd it by appending one of the following to your shell profile:\n\n"

  local shell_name
  shell_name="$(basename "${SHELL:-bash}")"
  case "$shell_name" in
    zsh)
      printf "  echo 'export PATH=\"%s:\$PATH\"' >> ~/.zshrc\n" "$INSTALL_DIR"
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

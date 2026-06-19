#!/usr/bin/env bash
# install-secret-scanners.sh — install gitleaks + trufflehog for oss-sweep
#
# Installs gitleaks (system package or binary) and trufflehog (~/bin).
# This script should be idempotent — running it twice causes no harm.
#
# gitleaks  — pre-installed on this system at /usr/bin/gitleaks.
#              If missing: sudo apt install gitleaks
# trufflehog — installed to ~/bin/trufflehog (user-writable, no sudo needed).
#              Install script from trufflesecurity/trufflehog.

set -euo pipefail

install_trufflehog() {
  local dest="$HOME/bin/trufflehog"
  if [ -x "$dest" ]; then
    echo "[install-scanners] trufflehog already installed at $dest"
    return 0
  fi
  mkdir -p "$HOME/bin"
  echo "[install-scanners] Downloading trufflehog to $dest..."
  curl -sSL https://raw.githubusercontent.com/trufflesecurity/trufflehog/main/scripts/install.sh \
    | sh -s -- -b "$HOME/bin"
  chmod +x "$dest"
  echo "[install-scanners] trufflehog installed: $("$dest" version 2>&1)"
}

install_gitleaks() {
  if command -v gitleaks >/dev/null 2>&1; then
    echo "[install-scanners] gitleaks already available: $(command -v gitleaks)"
    return 0
  fi
  echo "[install-scanners] gitleaks not found on PATH." >&2
  echo "[install-scanners] To install: sudo apt install gitleaks" >&2
  echo "[install-scanners] Or: brew install gitleaks (macOS)" >&2
  return 1
}

echo "[install-scanners] Starting secret scanner install..."

install_gitleaks
install_trufflehog

echo "[install-scanners] Done. PATH should include \$HOME/bin for trufflehog:"
echo "  gitleaks : $(command -v gitleaks)"
echo "  trufflehog: $HOME/bin/trufflehog"
echo ""
echo "Verify scans:"
echo "  export PATH=\"\$HOME/bin:\$PATH\""
echo "  ./bin/secret-scan-gate.sh"
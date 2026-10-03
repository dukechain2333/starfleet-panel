#!/usr/bin/env bash
# Removes what install.sh installed.
set -euo pipefail

MOD_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills/starfleet-panel"

if [ -L "$MOD_DIR" ] || [ -f "$MOD_DIR/.installed-by-starfleet-panel" ]; then
  rm -rf "$MOD_DIR"
  echo "removed the Claude Code mod; new sessions start without it"
elif [ -e "$MOD_DIR" ]; then
  echo "$MOD_DIR was not installed by starfleet-panel; left it alone" >&2
  exit 1
else
  echo "nothing to remove"
fi

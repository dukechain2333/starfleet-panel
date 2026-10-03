#!/usr/bin/env bash
# Installs starfleet-panel, the Claude Code mod, for the current user:
#   ~/.claude/skills/starfleet-panel   (loads in new sessions as starfleet-panel@skills-dir)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
MOD_DIR="$CLAUDE_DIR/skills/starfleet-panel"
MARKER=".installed-by-starfleet-panel"

link_mod=0

usage() {
  cat <<USAGE
Usage: ./install.sh [--link]

  --link   symlink the mod to this checkout instead of copying it
           (for developing the mod; edits apply to new sessions)
USAGE
}

for arg in "$@"; do
  case "$arg" in
    --link) link_mod=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1;38;2;0;0;0;48;2;255;153;0m LCARS \033[0m %s\n' "$*"; }
note() { printf '\033[1;38;2;153;204;255m  note:\033[0m %s\n' "$*"; }
warn() { printf '\033[1;38;2;255;204;51m  warning:\033[0m %s\n' "$*" >&2; }

if [ -e "$MOD_DIR" ] && [ ! -L "$MOD_DIR" ] && [ ! -f "$MOD_DIR/$MARKER" ]; then
  warn "$MOD_DIR exists and was not installed by starfleet-panel; left it alone"
  exit 1
fi

rm -rf "$MOD_DIR"
mkdir -p "$(dirname "$MOD_DIR")"
if [ "$link_mod" = 1 ]; then
  ln -s "$REPO/plugin" "$MOD_DIR"
  say "linked the Claude Code mod: $MOD_DIR -> $REPO/plugin"
else
  mkdir -p "$MOD_DIR"
  tar -C "$REPO/plugin" --exclude=./tests --exclude=./.claude --exclude=./.claude-plugin/types \
    --exclude=./node_modules -cf - . | tar -C "$MOD_DIR" -xf -
  touch "$MOD_DIR/$MARKER"
  say "installed the Claude Code mod: $MOD_DIR"
fi
say "start a new Claude Code session to load it (it shows up as starfleet-panel@skills-dir)"

if [ ! -e "$CLAUDE_DIR/skills/red-alert" ]; then
  note "red-alert is not installed; the panel works without it. For audible alerts and the"
  note "matching alert band: https://github.com/dukechain2333/red-alert"
fi

if grep -q '"statusLine"' "$CLAUDE_DIR/settings.json" 2>/dev/null; then
  note "your settings.json has a \"statusLine\" command, which keeps drawing its own line"
  note "under the prompt. Remove that entry to let the LCARS panel take over."
fi

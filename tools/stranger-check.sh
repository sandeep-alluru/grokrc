#!/usr/bin/env bash
#
# Install grokrc the way someone who has never seen this machine would.
#
# The earlier "clean install" check was not clean: it ran as the author, with
# grok already on PATH, ~/.grok/auth.json already present, and ~/.grokrc/config.json
# already written. `grokrc doctor` passed because of the machine, not the package.
#
# ISOLATED HERE (everything grokrc actually reads):
#   HOME          fresh empty dir  -> no ~/.grok, ~/.grokrc, ~/.npmrc, no history
#   PATH          system only      -> no grok, no author-installed binaries
#   npm cache     fresh            -> nothing warmed
#
# NOT ISOLATED (no user namespaces on this kernel; bwrap and unshare are denied):
#   kernel, system packages, and the installed Node version. A stranger on
#   Node 18, or without build tools, is NOT covered by this script.
#
# Usage: tools/stranger-check.sh [--pkg grokrc|<tarball path>]
set -u

PKG="${2:-grokrc}"
PASS=0; FAIL=0
ok()   { echo "  ✓ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ✗ $1"; [ -n "${2:-}" ] && echo "      $2"; FAIL=$((FAIL+1)); }
head2() { sed -n '1,6p' | sed 's/^/      /'; }

REAL_GROK_DIR=$(dirname "$(command -v grok 2>/dev/null || echo /nonexistent/grok)")

SB=$(mktemp -d /tmp/grokrc-stranger-XXXXXX)
export HOME="$SB"
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export npm_config_cache="$SB/.npm"
export npm_config_prefix="$SB/.local"
export XDG_CONFIG_HOME="$SB/.config" XDG_DATA_HOME="$SB/.local/share"
unset GROK_HOME GROKRC_HOME
mkdir -p "$SB/.local" "$SB/projects"
cd "$SB" || exit 1

echo
echo "  stranger check — HOME=$SB"
echo "  node $(node -v 2>&1), npm $(npm -v 2>&1)"
echo

# ── the machine really is bare ────────────────────────────────────────────────
[ -z "$(command -v grok)" ] && ok "grok is NOT installed (as a stranger's would be)" \
  || bad "grok leaked into the sandbox PATH" "$(command -v grok)"
[ ! -e "$HOME/.grok" ]   && ok "no Grok credentials in HOME"   || bad "~/.grok leaked in"
[ ! -e "$HOME/.grokrc" ] && ok "no grokrc config in HOME"      || bad "~/.grokrc leaked in"

# ── install exactly as the README says ────────────────────────────────────────
echo
echo "  installing $PKG from the public registry…"
if npm install -g "$PKG" >"$SB/install.log" 2>&1; then
  ok "npm install -g $PKG"
else
  bad "npm install -g $PKG failed"; sed -n '1,10p' "$SB/install.log" | sed 's/^/      /'
fi

BIN="$SB/.local/bin/grokrc"
[ -x "$BIN" ] && ok "grokrc binary is on the prefix" || bad "no grokrc binary produced"
[ -d "$SB/.local/lib/node_modules/grokrc/web" ] && ok "the PWA shipped with it" || bad "web/ missing from the package"

# ── does it behave without Grok installed? ────────────────────────────────────
echo
echo "  --- with NO grok installed ---"
DOC=$("$BIN" doctor 2>&1)
echo "$DOC" | head2
if echo "$DOC" | grep -qiE "not found|no grok|install"; then
  ok "doctor names the missing dependency"
else
  bad "doctor does not tell a stranger that grok is missing"
fi
echo "$DOC" | grep -qiE "Error:|ERR_|stack|Cannot find module" \
  && bad "doctor leaked a stack trace instead of a message" || ok "doctor fails cleanly, no stack trace"

UP=$(timeout 25 "$BIN" up --port 4498 2>&1)
echo "$UP" | head2
# STRICT: must name the missing binary, not merely contain the word "grok"
# somewhere in an unrelated warning — which is how this check first passed.
echo "$UP" | grep -qiE "grok (was )?not found|not found on PATH|install: curl" \
  && ok "up explains the missing dependency" || bad "up does not explain what is missing"

# ── with grok present but nobody logged in ────────────────────────────────────
echo
echo "  --- with grok present but NOT logged in ---"
mkdir -p "$SB/.local/bin"
if [ -x "$REAL_GROK_DIR/grok" ]; then
  ln -sf "$REAL_GROK_DIR/grok" "$SB/.local/bin/grok"
  export PATH="$SB/.local/bin:$PATH"
  DOC2=$("$BIN" doctor 2>&1)
  echo "$DOC2" | head2
  echo "$DOC2" | grep -qi "grok found" && ok "doctor finds grok once it is installed" \
    || bad "doctor cannot see a grok that is on PATH"
  # STRICT: grokrc must TELL the user what to run. Matching "auth" inside the
  # agent's own "Authentication required (-32000)" is the agent talking, not us.
  echo "$DOC2" | grep -qiE "grok login|run .grok login|sign in with .grok" \
    && ok "doctor tells a logged-out user to run \`grok login\`" \
    || bad "doctor passes the agent's raw auth error through without saying what to do"
else
  echo "      (no grok binary to link — skipped, denominator 2 checks)"
fi

# ── the one required setting ──────────────────────────────────────────────────
echo
echo "  --- required configuration ---"
CFG=$("$BIN" config 2>&1); echo "$CFG" | head2
echo "$CFG" | grep -qi "defaultCwd" && ok "config tells a stranger defaultCwd is needed" \
  || bad "config does not surface the one required setting"

"$BIN" config set defaultCwd "$SB/projects" >/dev/null 2>&1 \
  && ok "config set defaultCwd works" || bad "config set failed"
grep -q "$SB/projects" "$HOME/.grokrc/config.json" 2>/dev/null \
  && ok "the setting persisted to a fresh HOME" || bad "config did not persist"

echo
echo "  ── $PASS passed, $FAIL failed ──"
echo "  sandbox: $SB (removing)"
cd /; rm -rf "$SB"
[ "$FAIL" -eq 0 ]

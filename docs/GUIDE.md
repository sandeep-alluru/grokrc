# grokrc guide

Everything you need to install, run, and operate grokrc.  
For design internals see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Requirements

- **Node.js 20+**
- **[Grok Build](https://docs.x.ai/build/overview)** (`grok` on your `PATH`) and `grok login`
- A phone browser that can open a URL on your network (or via Tailscale / relay)

| Platform | Status | Service helper |
|---|---|---|
| Linux | Supported (CI) | systemd user unit |
| macOS | Supported (CI) | — |
| Windows | Supported (CI) | Scheduled Task scripts |

---

## Install

```bash
# Grok Build
curl -fsSL https://x.ai/cli/install.sh | bash
grok login

# grokrc
npm install -g grokrc
```

Without global write access:

```bash
npm config set prefix ~/.local
npm install -g grokrc
export PATH="$HOME/.local/bin:$PATH"
```

From source:

```bash
git clone https://github.com/sandeep-alluru/grokrc.git
cd grokrc && npm install && npm run build && npm link
```

---

## Required configuration

### 1. Default project directory

Sessions started from the phone open in `defaultCwd`. There is **no default** — set it explicitly:

```bash
grokrc config set defaultCwd /path/to/your/projects
grokrc config                    # show settings
```

Under systemd, the process cwd is often `$HOME`, which is not a project. Set `defaultCwd` before relying on new sessions.

### 2. Grok must ask for permission

Grok Build defaults **`support_permission` off**. With that (or `permission_mode` of `auto` / `dontAsk` / `bypassPermissions` / `acceptEdits`), the agent never sends `session/request_permission` — one-tap approval does nothing and tools run unattended.

Put this in **`~/.grok/config.toml`** (user config only; project files do not override it):

```toml
[features]
support_permission = true

[ui]
permission_mode = "default"
```

Then:

```bash
grokrc doctor    # reports whether approvals will fire
```

---

## Start the daemon

```bash
grokrc up --lan          # bind all interfaces (LAN)
# or
grokrc up                # loopback only
```

You get a URL and a 6-character pairing code. On your phone:

1. Open the URL  
2. Enter the code  
3. **Add to Home Screen** (required for iOS push)

```bash
grokrc pair              # new code (daemon must be running)
grokrc devices           # paired devices
grokrc revoke <id>       # remove a device
grokrc revoke --all
```

---

## Daily use

### Sessions

| Mode | How it appears | Control |
|---|---|---|
| **Owned** | Started from the phone | Full |
| **Observed** | Hand-started `grok` TUI on the machine | Read-only until **Take over** |
| **Shared** | Via leader / `grokrc term` | Full, concurrent with terminal |

- **New session** — from the session list  
- **Resume** — open a past session; composer returns when live  
- **Approvals** — tool requests show as buttons; answer by option  
- **Stop** — cancel the current turn  
- **Take over** — stop the TUI owner and drive the session from the phone  
- **Hand back** — free the session for desktop; daemon tries to open a terminal with `grok -r <id>`; copy-paste commands stay as fallback  

### Terminal client

Same backend as the phone:

```bash
grokrc term
grokrc term --session <id>
```

### Commands

| Command | Purpose |
|---|---|
| `grokrc up [flags]` | Start daemon |
| `grokrc doctor` | Health check (agent, ACP, push, live daemon) |
| `grokrc config` / `config set` / `config unset` | Settings |
| `grokrc pair` / `devices` / `revoke` | Device auth |
| `grokrc term` | Terminal UI on a session |
| `grokrc relay` | Self-hosted relay server |

Useful `up` flags: `--port`, `--host`, `--lan`, `--pair`, `--relay <url>`, `--room`, `--relay-key`, `--no-push`, `--cwd`, `--model`, `--history`.

---

## Networking

### LAN

```bash
grokrc up --lan
```

Use only on a trusted network. Prefer Tailscale for anything beyond home lab.

### Tailscale (recommended for phones)

Serve HTTPS to your tailnet so the PWA and push work cleanly:

```bash
# example — adapt to your tailscale serve setup
tailscale serve https / http://127.0.0.1:4319
```

Open the `https://…ts.net` URL on the phone.

### Relay (outbound)

When you cannot open inbound ports:

```bash
# on a VPS
grokrc relay --port 8080

# on the dev machine
grokrc up --relay wss://your-vps:8080
```

The daemon dials **out**. Frames are encrypted; the room key travels in the URL fragment (not sent to the server).  
For pure transport with no JS from the relay: `grokrc relay --no-client`.

---

## Push notifications

Self-hosted **Web Push** (VAPID). No third-party push cloud.

| Platform | Notes |
|---|---|
| **iOS** | Safari **Add to Home Screen** only. Tab Safari and other iOS browsers do not support Web Push. |
| **Android** | Chrome / Firefox / Edge / Samsung Internet; HTTPS required. **Not yet tested on a physical Android device** — use `grokrc doctor` and a real device to confirm. |
| **Desktop** | Works where Push API + service worker are available |

The session list shows a notification row with status flags (`installed · pushAPI · sw · https · permission`) when something is missing.

Override VAPID subject if needed: `GROKRC_VAPID_SUBJECT=https://example.com` (must be a routable URL or `mailto:` for Apple).

---

## Run as a service

### Linux (systemd user unit)

```bash
# from a source checkout
./packaging/systemd/install.sh
systemctl --user enable --now grokrc
loginctl enable-linger $USER    # survive logout
```

### Windows (Scheduled Task)

See scripts under `packaging/windows/` (`install.ps1`, watchdog helpers). Run from an elevated PowerShell when installing the task.

### macOS

No service unit ships. Use `grokrc up` from a login item or your own launchd plist.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `doctor` / `up` says no agent | Install Grok Build; ensure `grok` is on `PATH` |
| Pairing “invalid” / expired | Codes expire; only one redeem each; run `grokrc pair` again (don’t issue many codes while typing one) |
| No text box on old session | Observed / finished sessions are read-only — **Resume** or start new |
| Approvals never appear | Set `support_permission` + `permission_mode = "default"` in `~/.grok/config.toml` |
| Push never on iPhone | Home Screen app + HTTPS; check notification row flags |
| Phone can’t reach daemon | Same LAN / Tailscale / relay; check bind (`--lan` vs loopback) |
| Hand-back: no terminal opens | Restart daemon after upgrades; use the copy-paste `grok -r` command; on Linux the machine needs a graphical session (`DISPLAY` / Wayland) |
| Stale UI after upgrade | Force-close the PWA; hard refresh; check daemon is running the new build |

```bash
grokrc doctor
grokrc devices
```

---

## FAQ

**Why not just put a terminal on my phone?**  
Grok exposes a structured agent protocol. Approvals, tools, and plans are typed events — not ANSI guesswork.

**Does the TUI and phone share one session?**  
Use `grokrc term` (or take over / hand back). Grok’s own TUI does not join a shared leader socket for this product path.

**Is my code sent to a cloud?**  
The agent runs on **your** machine with **your** Grok credentials. The phone talks to your daemon (or your relay). Credentials stay local.

**Can I use it on cellular?**  
Yes with Tailscale or relay mode.

**Android push?**  
Supported by the web platform in principle; **not validated on a physical Android device** yet.

---

## Uninstall

```bash
npm uninstall -g grokrc
# Linux service
systemctl --user disable --now grokrc 2>/dev/null
# Config and pairings (optional)
# rm -rf ~/.grokrc
```

---

## See also

- [Architecture](ARCHITECTURE.md)  
- [Security](../SECURITY.md)  
- [Changelog](../CHANGELOG.md)  

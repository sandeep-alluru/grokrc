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

Pick one path. **Tailscale is the recommended way to use grokrc from anywhere** (cellular, coffee shop, travel) without opening ports on your router.

| Path | When to use | Phone URL shape |
|---|---|---|
| **Loopback only** | Desktop browser on the same machine | `http://127.0.0.1:4319` |
| **LAN** | Phone on the same Wi‑Fi, trusted network | `http://192.168.x.x:4319` |
| **Tailscale** | Phone anywhere on your tailnet (recommended) | `https://your-machine.….ts.net` |
| **Relay** | You control a VPS; daemon dials **out** | Relay room URL (see below) |

### LAN (same Wi‑Fi only)

```bash
grokrc up --lan
```

The daemon binds `0.0.0.0` and prints a URL using a local address, for example:

```text
  grokrc listening on http://192.168.1.10:4319
  ⚠ bound to all interfaces — keep this on a trusted network or a Tailnet.
```

- Replace `192.168.1.10` with whatever address **your** machine prints (any `192.168.x.x`, `10.x.x.x`, or `172.16–31.x.x` is fine).
- Only devices on that private network can reach it.
- Do **not** port-forward this to the public internet.

---

### Tailscale (access from anywhere)

Tailscale puts your PC and phone on a private mesh VPN ([tailnet](https://tailscale.com/kb/1136/tailnet)). The phone can reach your machine on cellular; you do **not** open inbound ports on your home router.

This is the best default for real phone use: **HTTPS**, works off-LAN, and satisfies browser requirements for **Web Push** and a stable PWA install.

#### 1. Install and sign in

**On the machine that runs grokrc**

- Linux / macOS / Windows: install from [tailscale.com/download](https://tailscale.com/download)
- Sign in with the same account (or an account invited to the same tailnet)

```bash
# Linux example (package managers also work — see Tailscale docs)
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale status
```

**On the phone**

- Install the **Tailscale** app (iOS App Store / Google Play)
- Sign in to the **same** tailnet
- Leave Tailscale **connected** when you use grokrc away from home Wi‑Fi

#### 2. Start grokrc on the machine

Prefer loopback + Serve (nothing exposed on LAN):

```bash
grokrc up
# listens on 127.0.0.1:4319 by default
```

Or bind only the Tailscale interface if you prefer not to use Serve (HTTP, no TLS from Tailscale):

```bash
# Your Tailscale IP looks like 100.x.x.x — get it with:
tailscale ip -4

grokrc up --host 100.x.x.x --port 4319
```

Using raw `100.x.x.x:4319` works on many phones but is **HTTP**. For iOS push and a clean PWA install, use **Serve** (next step).

#### 3. Publish HTTPS with `tailscale serve`

On the **same machine** as the daemon, reverse-proxy **HTTPS** from your tailnet to local grokrc.  
`grokrc` should already be listening on `127.0.0.1:4319` (`grokrc up`).

**Allow your user to run Serve without `sudo` every time** (Linux; run once):

```bash
sudo tailscale set --operator=$USER
```

**Point Serve at grokrc** (background, survives the shell closing):

```bash
tailscale serve --bg http://127.0.0.1:4319
```

Some Tailscale versions also accept an explicit path form:

```bash
tailscale serve --bg https / http://127.0.0.1:4319
```

Either is fine if `serve status` shows a proxy to `127.0.0.1:4319`.

**Confirm:**

```bash
tailscale serve status
```

Example output (names are **samples** — yours will differ):

```text
https://dev-laptop.tail-abc123.ts.net (tailnet only)
|-- / proxy http://127.0.0.1:4319
```

**Phone URL** = that HTTPS hostname, for example:

```text
https://dev-laptop.tail-abc123.ts.net
```

Not the LAN address (`http://192.168.…`). Not a public Funnel URL.

| Placeholder | Meaning |
|---|---|
| `dev-laptop` | Your machine’s MagicDNS name (set in the Tailscale admin console or hostname) |
| `tail-abc123` | Your tailnet’s DNS suffix (unique per account/org) |

Find your real hostname with:

```bash
tailscale status
# or
tailscale serve status
```

#### 4. Pair from the phone

1. Phone: Tailscale app **on** and connected to the **same** tailnet  
2. Open your Serve URL, e.g. `https://dev-laptop.tail-abc123.ts.net`  
   (use **your** name from `tailscale serve status`, not this sample)  
3. Enter the pairing code (`grokrc pair` on the machine if you need a new one)  
4. **Add to Home Screen** (required for iOS notifications)

You can now leave home Wi‑Fi; as long as both devices are on the tailnet, the phone keeps working.

#### 5. Persist across reboot

| Piece | How |
|---|---|
| grokrc | Linux: systemd user unit — [Run as a service](#run-as-a-service). Windows: Scheduled Task scripts under `packaging/windows/`. |
| `tailscale serve` | `--bg` keeps the serve config; Tailscale usually restores it after reboot once the client is up. Re-run the `tailscale serve` command if `serve status` is empty after an upgrade. |

Order after reboot: Tailscale online → grokrc listening → Serve still points at `http://127.0.0.1:4319`.

#### Serve vs Funnel

| | `tailscale serve` | `tailscale funnel` |
|---|---|---|
| Who can connect | **Only your tailnet** | Public internet |
| For grokrc? | **Yes — use this** | **No** — remote control of a coding agent must not be public |

Do **not** enable Funnel for grokrc.

#### Tailscale troubleshooting

| Symptom | What to check |
|---|---|
| Phone can’t load the page | Tailscale connected on **both** devices; same tailnet; `tailscale status` shows the machine online |
| Connection refused | `grokrc` running? `curl -sS http://127.0.0.1:4319/api/health` on the machine |
| Serve 502 / bad gateway | Daemon not on `127.0.0.1:4319` — start `grokrc up` (not only Serve) |
| Wrong URL on phone | Use the **`https://….ts.net`** Serve URL, not an old LAN `http://192.168.…` bookmark |
| Works on Wi‑Fi, dies on cellular | Phone Tailscale disconnected or battery optimization killed the VPN app |
| iOS push still broken | Must be **Home Screen** PWA over **HTTPS** (Serve). Tab Safari is not enough |
| Certificate warnings | Use the MagicDNS / Serve hostname Tailscale issued; don’t invent hostnames |
| `tailscale serve` needs root / permission denied | Run once: `sudo tailscale set --operator=$USER`, then retry `serve` |
| `serve status` empty after reboot | Tailscale up? Re-run `tailscale serve --bg http://127.0.0.1:4319` |

```bash
# Machine-side health
grokrc doctor
curl -sS http://127.0.0.1:4319/api/health
tailscale status
tailscale serve status
```

---

### Relay (outbound, no Tailscale)

When you run a small VPS and the daemon must dial **out** (no inbound ports, no Tailscale):

```bash
# on a VPS you control
grokrc relay --port 8080

# on the dev machine
grokrc up --relay wss://relay.example.com:8080
```

The daemon dials out. Frames are encrypted; the room key travels in the URL fragment (browsers do not send fragments to the server).  
Pure transport with no JS from the relay: `grokrc relay --no-client` (install the PWA from the daemon origin first when you can).

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

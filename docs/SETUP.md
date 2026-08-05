# grokrc — Setup and Usage

Drive [xAI's Grok Build](https://docs.x.ai/build/overview) from your phone, over the
agent's own protocol rather than a screen scrape.

This guide takes you from nothing to a working install: local first, then reachable
from anywhere, then notifications. Each stage works on its own — stop wherever you
have what you need.

---

## Contents

1. [Requirements](#1-requirements)
2. [Install](#2-install)
3. [Configure — one required setting](#3-configure--one-required-setting)
4. [Turn on approvals — read this one](#4-turn-on-approvals--read-this-one)
5. [First run and pairing](#5-first-run-and-pairing)
6. [Reaching it from your phone](#6-reaching-it-from-your-phone)
7. [Run it as a service](#7-run-it-as-a-service)
8. [Push notifications](#8-push-notifications)
9. [The terminal client](#9-the-terminal-client)
10. [Session modes](#10-session-modes)
11. [Command reference](#11-command-reference)
12. [Troubleshooting](#12-troubleshooting)
13. [Security model](#13-security-model)
14. [Uninstall](#14-uninstall)

---

## 1. Requirements

| | |
|---|---|
| **Node.js** | 22 or newer (`node --version`) |
| **Grok Build** | on your `PATH` — `curl -fsSL https://x.ai/cli/install.sh \| bash` |
| **OS** | Linux or macOS. The systemd unit is Linux-only; everything else is portable |
| **A phone** | any browser. It installs as a PWA — no app store |

Check Grok is working before you start:

```bash
grok --version          # e.g. grok 0.2.118 (stable)
```

---

## 2. Install

```bash
git clone <your-fork-or-this-repo> grokrc
cd grokrc
npm install
npm run build
```

Put `grokrc` on your PATH. Either:

```bash
npm link                                   # needs write access to the global prefix
```

or, without root:

```bash
mkdir -p ~/.local/bin
ln -sf "$PWD/dist/cli.js" ~/.local/bin/grokrc
chmod +x dist/cli.js
# ensure ~/.local/bin is on your PATH
```

Verify:

```bash
grokrc doctor
```

`doctor` checks that Grok is installed, completes a real ACP handshake, creates and
then **removes** a throwaway session, and reports whether approvals will actually fire.

---

## 3. Configure — one required setting

```bash
grokrc config set defaultCwd /path/to/your/projects
```

**This has no default and grokrc will not guess one.** Sessions started from your
phone open in the daemon's working directory. Under systemd that is your home
directory — so without this, the agent starts with no project in context and you
will wonder why it can't see your code.

```bash
grokrc config                     # show everything
grokrc config set lan true        # listen on 0.0.0.0 instead of loopback
grokrc config unset model
```

| Key | Meaning |
|---|---|
| `defaultCwd` | **required** — working directory for new sessions |
| `port` | default `4319` |
| `host` | bind address; default `127.0.0.1` |
| `lan` | `true` binds `0.0.0.0` so other devices can reach it |
| `historyLimit` | how many past sessions to list (default 10) |
| `model` | model override for new sessions |
| `leader` | share one backend with `grok agent leader` |

Precedence: **CLI flag → `~/.grokrc/config.json` → built-in default.**
Settings are validated on write *and* on start — a `defaultCwd` that doesn't exist
is refused rather than silently ignored.

---

## 4. Turn on approvals — read this one

**Grok Build does not ask permission before running tools by default.**

`[features] support_permission` defaults to `false`, and your config may also set
`[ui] permission_mode = "auto"`. Under either, Grok never sends
`session/request_permission` — so grokrc's one-tap approval silently does nothing,
**and your agent executes writes and shell commands unattended.**

Put this in `~/.grok/config.toml`:

```toml
[features]
support_permission = true

[ui]
permission_mode = "default"
```

Neither key works from a project-level `.grok/config.toml` — both are user-config
only. `grokrc doctor` checks this and exits non-zero if approvals are inoperative;
`grokrc up` prints a warning you cannot miss.

If you deliberately want unattended execution, leave it — just know that the
approval UI is decoration until you change it.

---

## 5. First run and pairing

```bash
grokrc up
```

```
  grokrc listening on http://127.0.0.1:4319
  loopback only. Use --lan to reach it from your phone, or tunnel it.

  No paired devices. Open the URL above on your device and enter:

      A7K2QM

  (valid 5 minutes, single use)
```

Open that URL, enter the code. The device gets a long-lived token; the daemon
stores only a hash of it.

Need another device later:

```bash
grokrc up --pair          # prints a code even when devices are already paired
grokrc devices            # list paired devices
grokrc revoke <deviceId>  # or --all
```

---

## 6. Reaching it from your phone

Pick **one**.

### a. Same WiFi — simplest

```bash
grokrc config set lan true
grokrc up
```

Open `http://<your-lan-ip>:4319` on the phone.

Fine for a trusted home network. No HTTPS, so **push notifications will not work**
(browsers refuse service workers on plain HTTP).

### b. Tailscale — recommended

Works from anywhere including cellular, gives you a real certificate, and exposes
nothing on your LAN.

```bash
# once, on this machine
sudo tailscale set --operator=$USER
tailscale serve --bg --https=443 http://127.0.0.1:4319
```

Enable **HTTPS Certificates** in the Tailscale admin console
(<https://login.tailscale.com/admin/dns>) if you haven't — it's one toggle.

Install Tailscale on the phone and sign into the same tailnet. Then open
`https://<machine>.<tailnet>.ts.net`.

Keep the daemon on loopback (`lan` unset) — Tailscale fronts it.

### c. Relay — no inbound port at all

For when the phone can't join a tailnet. The daemon dials **out**; nothing listens
on your machine.

```bash
# on a VPS
grokrc relay --port 8080

# on your machine
grokrc up --relay ws://your-vps:8080
```

It prints a phone URL containing `#e=<secret>`. That fragment is the end-to-end
encryption key — **browsers never send fragments to servers**, so the relay routes
traffic it cannot read. Every WebSocket frame and tunnelled API body is AES-256-GCM
sealed.

> The relay still sees routing metadata (which `/api/*` route, sizes, timing) and
> **serves the client code**, so a malicious relay could serve modified JavaScript.
> Encryption cannot fix code delivery — self-host it. `--no-e2e` disables encryption
> and says so loudly.

---

## 7. Run it as a service

```bash
packaging/systemd/install.sh
```

A **user** unit, not a system one — it needs your `~/.grok/auth.json` and must spawn
agents as you, so no sudo is involved. The installer enables lingering so it starts
at boot and survives logout.

```bash
systemctl --user status grokrc
journalctl --user -u grokrc -f
systemctl --user restart grokrc
packaging/systemd/uninstall.sh          # keeps ~/.grokrc pairings
```

Flags go through `--`, though config is the better home for them:

```bash
packaging/systemd/install.sh -- --lan --pair
```

---

## 8. Push notifications

Notifications reach a locked phone when the agent finishes a turn or needs approval.
Self-hosted VAPID — they go to your browser vendor's push service and nowhere else.

**Requirements, all of them:**

1. **HTTPS.** Tailscale (6b) or the relay behind TLS. Plain LAN HTTP cannot work.
2. **Installed as a PWA.** On iOS, open the HTTPS URL in Safari →
   Share → **Add to Home Screen**, then launch from the icon. iOS refuses Web Push
   from a Safari tab (16.4+ required).
3. **Permission granted** when prompted, right after pairing.

Check the plumbing any time:

```bash
grokrc doctor
#   · push: 1 subscriber(s), 12 sent, 0 failed, 0 expired
```

`failed` counts real faults — bad keys, a rejecting push service, network. Those are
logged with the endpoint rather than swallowed. `expired` counts subscriptions the
browser dropped (404/410), which are pruned automatically. A fault never
unsubscribes a device: a transient outage must not silently disconnect your phone.

---

## 9. The terminal client

```bash
grokrc term                 # pick a session
grokrc term --new           # start a fresh one
grokrc term --session <id>
```

A terminal on the **same session your phone is driving** — both connect to the
grokrc daemon, so either can answer an approval and both see the same events.

It authenticates without a pairing code: it runs as you, and minting a device
requires write access to `~/.grokrc`, which anyone holding it could forge anyway.
Pairing codes exist to authenticate *remote* devices.

```
type a message and press enter · /q to quit · ctrl-c cancels the turn
```

Ctrl-C cancels the running turn rather than killing the client — your phone may
still be watching.

> **Why not Grok's own TUI?** It always runs its own agent and cannot join a shared
> backend. Verified: the TUI never connects to `leader.sock`, `use_leader` appears
> nowhere in Grok's documentation, and `grok --help` has no `--leader`. So
> terminal-and-phone on one conversation is impossible through the TUI — hence this
> client.

---

## 10. Session modes

| Mode | What it is | Can you type? |
|---|---|---|
| **owned** | started by grokrc — phone, terminal, or `+ New session` | yes |
| **observed** | a session started elsewhere, mirrored from its log | no — read-only |
| **shared** | running against `grok agent leader` | yes |

Observed sessions appear automatically. grokrc tails
`~/.grok/sessions/<cwd>/<id>/updates.jsonl`, which Grok writes for every session, so
**installing grokrc does not change how you already work** — your terminal sessions
simply become visible on your phone.

**Resuming.** Any past session offers a **Resume** button and comes back with full
context, because Grok supports `session/load`. A session another process still owns
shows *"live in terminal"* and offers no Resume — joining it would put a second
agent on one conversation. That guard is enforced in the daemon, not just the UI.

---

## 11. Command reference

```
grokrc up            start the daemon
    --port <N>         port (default 4319)
    --host <H>         bind address (default 127.0.0.1)
    --lan              bind 0.0.0.0
    --leader           share one backend with `grok agent leader`
    --model <M>        model override
    --cwd <DIR>        working directory for new sessions
    --pair             print a pairing code even if devices exist
    --history <N>      how many past sessions to list
    --relay <URL>      dial out to a relay
    --no-e2e           disable relay encryption (says so loudly)
    --no-push          disable push entirely

grokrc term          terminal client (--new · --session <id> · --url <URL>)
grokrc relay         run a relay server (--port N)
grokrc config        show · set <key> <value> · unset <key>
grokrc devices       list paired devices
grokrc revoke <id>   revoke a device (--all)
grokrc doctor        check grok, ACP, approvals, and push
```

---

## 12. Troubleshooting

**"agent will NOT prompt — remote approval is inoperative"**
Section 4. `support_permission` is off; approvals cannot fire.

**Phone can't reach the URL**
LAN: is `lan` set to `true`, and is the phone on the same network?
Tailscale: is the *phone* enrolled? `tailscale status` must list it — `tailscale serve`
is tailnet-only by design and unreachable from non-members.

**Sessions open in the wrong directory**
`grokrc config set defaultCwd /path/to/projects`, then restart.

**No notifications**
All three of section 8 are required. Most often it's #2 — opened in a Safari tab
rather than launched from the home screen.

**Session list cluttered with old sessions**
`grokrc config set historyLimit 5`. Live sessions always show regardless.

**The daemon died**
`journalctl --user -u grokrc -n 50`. An agent exiting cannot take the daemon with it
— that path is covered by tests — so a crash is worth reporting.

**Diagnosing in order:** network → TLS → daemon reachable (`/api/health`) → pairing →
agent. `grokrc doctor` covers the last two.

---

## 13. Security model

**Remote control of a coding agent is remote code execution by design.** Treated
accordingly:

- **Pairing codes** are single-use and expire in 5 minutes.
- **Only a SHA-256 hash** of each device token is stored; comparison is constant-time.
- **Loopback by default.** `lan` is opt-in and warns.
- **Session ids and working directories from clients are validated** — no path
  traversal, no spawning an agent in an arbitrary directory.
- **Resource ceilings**: 12 live sessions, 24 observed, 1 MiB WebSocket frames.
- **Grok's own credentials never leave the machine** and are never proxied to a client.
- **Default-deny approvals.** grokrc never passes `--always-approve` or
  `bypassPermissions`. Remote approval means a human tapping a button.
- **Relay isolation**: a daemon may only answer requests belonging to its own room,
  enforced server-side.

What this does **not** protect against: someone with write access to `~/.grokrc`
(they can mint a device token), or a malicious relay serving modified client code.

---

## 14. Uninstall

```bash
packaging/systemd/uninstall.sh     # remove the service, keep pairings
rm -rf ~/.grokrc                   # device tokens, push keys, settings
rm ~/.local/bin/grokrc             # or: npm unlink
tailscale serve --https=443 off    # if you used Tailscale
```

Grok's own sessions in `~/.grok/sessions` are untouched — grokrc never owned them.

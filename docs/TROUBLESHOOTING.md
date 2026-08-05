# Troubleshooting

Symptom-first. Find your symptom, follow the checks in order.

**Start here for anything:**

```bash
grokrc doctor
```

It verifies that `grok` exists, that ACP responds, that a session can be created, and —
crucially — whether the agent will prompt for approvals at all.

---

## Contents

- [The agent never asks for approval](#the-agent-never-asks-for-approval)
- [The phone cannot reach the daemon](#the-phone-cannot-reach-the-daemon)
- [Pairing code rejected or expired](#pairing-code-rejected-or-expired)
- [Session list is empty](#session-list-is-empty)
- [A session I started in the terminal does not appear](#a-session-i-started-in-the-terminal-does-not-appear)
- [I cannot type in a session](#i-cannot-type-in-a-session)
- [Resume fails](#resume-fails)
- [Notifications never arrive](#notifications-never-arrive)
- [The connection dot keeps going red](#the-connection-dot-keeps-going-red)
- [The daemon exits at startup](#the-daemon-exits-at-startup)
- [systemd service will not start](#systemd-service-will-not-start)
- [Relay problems](#relay-problems)
- [Still stuck](#still-stuck)

---

## The agent never asks for approval

**Almost always a Grok config problem, not a grokrc problem.**

```bash
grokrc doctor
# ✗ agent will NOT prompt — remote approval is inoperative
```

Grok Build ships with permission prompting **off**. Edit `~/.grok/config.toml`:

```toml
[features]
support_permission = true

[ui]
permission_mode = "default"
```

Both matter:

- `support_permission` unset or `false` → Grok never sends `session/request_permission`.
- `permission_mode = "auto"` → prompts are auto-answered even when the above is true.

Restart the daemon after changing it. Sessions created before the change keep the old
behaviour.

> This is a safety issue, not just a missing button: with prompting off, the agent takes
> actions without asking anyone, in your terminal as much as on your phone.

---

## The phone cannot reach the daemon

Work down this list.

**1. Is the daemon listening where you think?**

```bash
grokrc doctor
ss -tlnp | grep 4319
```

By default it binds `127.0.0.1` — **loopback only**. Your phone cannot reach that. You
need one of `--lan`, Tailscale, or a relay.

**2. Using Tailscale?**

```bash
tailscale status          # is this machine connected?
tailscale serve status    # is 4319 actually being served?
```

Then confirm the **phone** is connected too — open the Tailscale app. A phone that
dropped off the tailnet gives exactly the same symptom as a daemon that is down.

**3. Using `--lan`?**

Confirm both devices are on the same network and that the address is right:

```bash
grokrc up --lan
#   grokrc listening on http://192.168.1.20:4319
```

Some routers have client isolation enabled on the guest network. Try the main SSID.

**4. Test from the machine itself first.**

```bash
curl -s http://127.0.0.1:4319/api/health
# {"ok":true,"version":"0.1.0"}
```

If that fails, the problem is the daemon, not the network.

---

## Pairing code rejected or expired

- Codes are **valid 5 minutes** and **single use**. Generate a fresh one.
- The alphabet excludes `I`, `L`, `O`, `0`, and `1` to avoid ambiguity — if you see
  something that looks like a zero it is the letter `O`... which is not in the alphabet
  either. Look again; it is probably `Q` or `D`.
- Case does not matter; it is upper-cased before comparison.
- To issue a new code, ask the running daemon:

  ```bash
  grokrc pair
  ```

  No restart needed. This works whether the daemon runs in a terminal or under systemd.

**"No grokrc daemon is running"** — `grokrc pair` refuses to print a code when nothing is
listening, because it would live in a process about to exit and nothing could redeem it.
Start the daemon first.

**"control socket unavailable"** at startup means `~/.grokrc/control.sock` could not be
created — usually a permissions problem on `~/.grokrc`, or a second daemon already
running. The daemon still serves phones; only `grokrc pair` is affected.

---

## Session list is empty

- **No sessions exist yet.** Tap **New session**.
- **`defaultCwd` is not set.** grokrc refuses to guess a working directory for an agent
  that can modify files. Set it:

  ```bash
  grokrc config set defaultCwd ~/code
  ```

- **`--history` is 0 or very low.** Past sessions are listed up to that count
  (default 10).

---

## A session I started in the terminal does not appear

Observed mode tails Grok's own session log. Check:

1. **Is it actually a Grok Build session?** Only `grok` writes the logs grokrc reads.
2. **Same user and home directory?** The daemon reads `~/.grok/`. A session started as
   another user, or under a different `HOME` (containers, `sudo`), is invisible to it.
3. **Give it a second.** Observed sessions are discovered by polling.
4. **Live cap.** Observed sessions count toward the listing limits — 12 live, 24
   observed. Close some.

---

## I cannot type in a session

The composer is hidden on purpose for **observed** sessions — the daemon did not spawn
that agent, so it has no channel to send a prompt.

The header will say `past session` or `live in terminal`.

- **Past session** → tap **Resume** to take it over.
- **Live in terminal** → stop it in the terminal first, then Resume.

---

## Resume fails

The error text names the cause. Common ones:

| Message mentions        | Fix                                                                 |
| ----------------------- | ------------------------------------------------------------------- |
| working directory       | The directory moved or was deleted. `cwd` must be an existing absolute path. |
| session limit / cap     | 12 live sessions max. Close some.                                    |
| live in terminal        | Another process holds it. Stop Grok there first.                     |
| `loadSession`           | Your Grok build does not support it — check `grokrc doctor` output.  |

If Resume appears to do nothing at all, check the daemon log. Prompt and resume errors
are surfaced to the client, so silence points at a connection problem instead.

---

## Notifications never arrive

Work through these in order — the first two account for nearly everything.

**1. On iPhone, are you in the home-screen app?**

Apple permits Web Push **only** in a home-screen app installed from **Safari**.

- A Safari **tab** cannot do push, even at the same URL.
- **Chrome, Firefox, DuckDuckGo, Brave, and Edge on iOS cannot do push at all.** They
  use WebKit without the capability. There is no setting that enables it.

Install it properly: Safari → **Share** → **Add to Home Screen** → open from the icon.
The app should show **no address bar**. Then tap **🔔 Enable notifications** → **Allow**.

**2. Read what the notification row says.** It reports its actual state rather than
disappearing:

| Row says                                   | Meaning                                              |
| ------------------------------------------ | ---------------------------------------------------- |
| `Tap Share → Add to Home Screen…`          | You are in a browser tab. Install it.                |
| `This browser does not support push…`      | Third-party iOS browser, or an old browser.          |
| `Needs HTTPS`                              | You are on plain `http://`. Use Tailscale or a relay. |
| `blocked in system settings`               | Permission was denied earlier. See step 4.           |
| `daemon has push disabled (--no-push)`     | Restart the daemon without that flag.                |

**3. Is anything subscribed?**

```bash
grokrc doctor
#   · push: 1 subscriber(s), 12 sent, 0 failed, 0 expired
```

`0 subscriber(s)` means the browser never registered — go back to steps 1–2. Pairing and
subscribing are **separate**; a paired phone is not automatically subscribed.

**4. Permission stuck on denied?**

iOS: Settings → Notifications → **grokrc** → Allow Notifications.
Then reopen the app and tap the row again.

**5. HTTPS.** Push requires a secure context. `http://192.168.x.x` will never work.

---

## The connection dot keeps going red

- **Reconnect is automatic** with exponential backoff up to 15 s. A brief red dot is
  normal after a network change.
- **Red then back to the pairing screen** means the token was rejected (`close 4401`) —
  the device was revoked, or the auth store was reset. Pair again.
- **Constant red** — check the daemon is running:

  ```bash
  systemctl --user status grokrc
  curl -s http://127.0.0.1:4319/api/health
  ```

Prompts typed while disconnected are queued and sent on reconnect, so you should not
lose work to a flap.

---

## The daemon exits at startup

```bash
grokrc doctor
```

| Symptom                          | Cause                                                         |
| -------------------------------- | ------------------------------------------------------------- |
| `grok not found`                 | Not on `PATH`. Check with `which grok`.                       |
| ACP handshake fails              | Grok version too old, or `grok agent stdio` errors — run `npm run probe` |
| `EADDRINUSE`                     | Port 4319 is taken. `--port 4320`, or stop the other instance. |
| Complains about `defaultCwd`     | Set it, or pass `--cwd`. It must be an existing absolute directory. |

---

## systemd service will not start

```bash
systemctl --user status grokrc
journalctl --user -u grokrc -n 50 --no-pager
```

Known gotchas, all of which have bitten this project:

- **Arguments must not be quoted as one string.** In `~/.config/grokrc/grokrc.env`,
  `GROKRC_ARGS=--lan --pair` is right; `GROKRC_ARGS="--lan --pair"` is passed as a
  single argument and parses as neither.
- **`enable --now` does not restart a running service.** Use `systemctl --user restart`.
- **Capability directives are system-unit only.** They produce `218/CAPABILITIES` in a
  user unit.
- **The service dies at logout** unless lingering is on:

  ```bash
  loginctl enable-linger "$USER"
  ```

---

## Relay problems

**The phone gets the page but never connects.**
The URL must carry `?room=` and `&key=`. If you retyped it by hand you probably lost the
fragment (`#e=…`) — that is the encryption secret, and without it the client cannot
decrypt anything. Use the full URL the daemon printed.

**"It works on my laptop but not my phone."**
The fragment is dropped by some link previewers and chat apps. Copy the URL as text, do
not tap a preview.

**Relay is up but the daemon never registers.**
The daemon dials out; check egress is allowed and the relay URL includes the scheme:
`https://relay.example.com`, not `relay.example.com`.

---

## Still stuck

Open an issue with:

```bash
grokrc doctor                                   # paste verbatim
journalctl --user -u grokrc -n 100 --no-pager   # if running as a service
```

Plus your browser/OS, whether the app is installed to the home screen, and how the
daemon is reached (loopback, `--lan`, Tailscale, relay).

**Redact tokens and pairing codes before posting.**

- [Bug report](https://github.com/sandeep-alluru/grokrc/issues/new?template=bug_report.yml)
- Security problems: see [SECURITY.md](../SECURITY.md) — do not open a public issue.

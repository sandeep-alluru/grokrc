# FAQ

Short answers. Longer ones live in the [User Guide](USER-GUIDE.md) and
[Troubleshooting](TROUBLESHOOTING.md).

---

### What is this, in one sentence?

A phone client for [xAI's Grok Build](https://github.com/xai-org/grok-build) that talks
to the agent over its own protocol (ACP), so approvals and tool calls are real UI
instead of a terminal rendered on a small screen.

### How is it different from MobileCLI, Happy, CloudCLI, or Orca?

Those stream raw PTY bytes to a phone and run regexes over ANSI output to guess whether
the agent is waiting for you. They do that because Claude Code and Codex give them no
choice — there is no structured protocol to use.

Grok Build exposes one. grokrc reads typed JSON: `session/request_permission` arrives
with real options, so approving a tool is a tap answered by `optionId`, not a keystroke
you hope lands in the right place. None of those tools support Grok Build at all.

### Does it work with Claude Code / Codex / Cursor / Aider?

No. It is built on ACP as Grok Build implements it. Supporting another agent means
another transport adapter.

### Do I need a server, an account, or a cloud service?

No. The daemon runs on your machine. Push uses self-hosted VAPID keys generated locally.
The optional relay is a program you can run yourself on any VPS.

### Is my code sent anywhere?

Only to Grok, exactly as it would be if you used the terminal. grokrc adds no telemetry
and no third-party services. If you use a relay, traffic through it is end-to-end
encrypted and the relay cannot read it.

### Is there an App Store or Play Store app?

No, and there is unlikely to be. grokrc is a progressive web app served by your own
daemon. You open a URL, and optionally add it to your home screen. Nothing to install
from a store, nothing to update.

### Why does the phone show sessions I started in the terminal?

That is **observed mode**. grokrc tails Grok's own `updates.jsonl`, so it can show you a
session it did not start. Those are read-only — the daemon has no ACP channel to an
agent it did not spawn. To take one over, stop it in the terminal and tap **Resume**.

### Can I have one session live in my terminal and on my phone at once?

Yes — with `grokrc term`, which connects to the grokrc daemon. Both drive the same
session simultaneously.

**Not** with Grok's own TUI. That was verified four ways: the TUI never connects to
`leader.sock`, `use_leader` appears zero times in Grok's README, `grok inspect` surfaces
no leader config, and `grok --help` has no `--leader`.

### I started a session in the terminal and I am now away from the machine. Can I drive it?

Yes. Open it on the phone and tap **Take over** — it stops the terminal's `grok` and
resumes the session here with full history. To give it back later, either open
`grokrc term --session <id>` (no handback needed, both work at once) or tap **⇄ Hand
back to terminal** and run the `grok -r <id>` command it shows you.

### Could Take over kill the wrong process?

It is guarded against the realistic way that happens. Grok's `active_sessions.json` can
name a pid that has died and been recycled onto an unrelated program — `process.kill(pid, 0)`
reports "alive" for any process. So the daemon reads `argv[0]` and refuses unless it is
literally `grok`, refuses to signal itself, and sends `SIGTERM` only.

`test/takeover.test.ts` spawns real processes and asserts the bystander survives; the
guard is verified load-bearing by disabling it and watching the bystander die.

### Why do I never see approval buttons?

Grok ships with permission prompting **off** (`support_permission = false`). Run
`grokrc doctor` — it detects this and prints the fix. This is worth caring about beyond
grokrc: with the default, the agent acts without asking anyone.

### Why won't notifications work on my iPhone?

Apple permits Web Push only in a **home-screen app installed from Safari**, over HTTPS.

- A Safari **tab** cannot do push, even at the same URL.
- **Chrome, Firefox, DuckDuckGo, Brave, and Edge on iOS cannot do push at all** — they
  run on WebKit without the capability, and no setting changes it.

Safari → Share → Add to Home Screen → open from the icon → tap **🔔 Enable
notifications**. The app should show no address bar.

### Are notifications required?

No. Everything else works without them — sessions, streaming, approvals, resume.

### Do I need to expose a port to the internet?

No. Three options, none of which require it:

- **Tailscale** (recommended) — tailnet-scoped HTTPS
- **Relay** — the daemon dials **out**; nothing listens locally
- **`--lan`** — local network only

### How safe is relay mode, really?

The relay routes traffic it cannot read. Payloads are AES-256-GCM encrypted end to end,
and the key travels in the URL **fragment**, which browsers never transmit to a server.

The caveat: **the URL is a credential.** Anyone with it has your session. A malicious
relay cannot read or forge traffic, but it can drop it.

### What happens if I lose my phone?

```bash
grokrc devices
grokrc revoke <id>       # or: grokrc revoke --all
```

The socket closes immediately and the token stops working.

### Does closing the app stop the agent?

No. The daemon owns the session. Lock your phone mid-turn and the work continues; reopen
and you get the full transcript.

### How does `grokrc pair` reach the running daemon?

Over a Unix domain socket at `~/.grokrc/control.sock`, mode `0600`. Pairing codes live in
the daemon's memory — `beginPairing()` writes them there, `redeem()` reads them from
there — so a code must be minted by the process that will redeem it.

It is a socket rather than an HTTP route because the HTTP server may be bound to
`0.0.0.0` with `--lan`, and an unauthenticated "issue me a pairing code" endpoint
reachable from the network would hand anyone on the Wi-Fi a way in. A Unix socket has no
network presence at all; access is filesystem permissions.

### Why won't it start without `defaultCwd`?

Because it would have to guess where to run an agent that can modify files. It refuses.

```bash
grokrc config set defaultCwd ~/code
```

### Why only 12 live sessions?

Each is a real `grok` process. The cap keeps a runaway loop from filling your machine.
Observed sessions are capped separately at 24.

### Which Node version?

20 or newer; developed on 22.x. TypeScript tests run directly via
`--experimental-strip-types`.

### Which Grok Build version?

Developed against `0.2.118`. `grokrc doctor` verifies the ACP handshake against whatever
you have.

### Is it on npm?

Not yet. Install from source — see [SETUP.md](../SETUP.md).

### Can I use it on Android?

The app itself works anywhere with a modern browser — pairing, sessions, approvals and
`grokrc term` handoff are all plain HTTPS and WebSocket.

Notifications are more straightforward on Android than on iOS: Chrome supports Web
Push in an ordinary tab, with none of the home-screen requirements Safari imposes.
That path has **not been tested on a physical Android device**, so it is untested
rather than known-good. The full procedure is in
[USER-GUIDE §10](USER-GUIDE.md#on-android).

The docs are iOS-heavy because iOS is where it is hardest, not because Android is
better supported.

### Is it production-ready?

It is pre-1.0 software that one person uses daily. The suite includes browser tests
against the real PWA and real-stack checks that drive an actual `grok` process — run
`npm test` for the current count rather than trusting a number written here. There
has been no third-party security audit. Read [SECURITY.md](../SECURITY.md) and decide
for yourself.

### How do I report a bug?

[Open an issue](https://github.com/sandeep-alluru/grokrc/issues/new?template=bug_report.yml)
with `grokrc doctor` output. For security problems, see [SECURITY.md](../SECURITY.md) —
please do not open a public issue.

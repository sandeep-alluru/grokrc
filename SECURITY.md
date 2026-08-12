# Security Policy

grokrc gives a phone the ability to run a coding agent on your machine. That makes
its security properties load-bearing, not decorative. This document states what it
actually guarantees, what it does not, and how to report a problem.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Use GitHub's private reporting:
[**Report a vulnerability**](https://github.com/sandeep-alluru/grokrc/security/advisories/new)

If that is unavailable, email **salluru.work@gmail.com** with `grokrc security` in the
subject line.

Please include:

- what an attacker can do, and what they need to start (network position, a token, a
  paired device, physical access)
- a reproduction — a script, a request sequence, or a test that fails
- the version (`grokrc --version`) and how the daemon was reached (loopback, `--lan`,
  Tailscale, relay)

**What to expect:** acknowledgement within 7 days, and an assessment within 30. This is
a personal project maintained by one person — there is no paid bounty and no on-call
rotation. Fixes land on `main` with a note in [CHANGELOG.md](CHANGELOG.md). Credit is
given in the release notes unless you prefer otherwise.

## Supported versions

| Version | Supported |
| ------- | --------- |
| `main` / latest npm | ✅ |
| older releases | ❌ |

Only current `main` and the latest npm release receive fixes.

## Threat model

### What grokrc assumes

- **The machine running the daemon is trusted.** Anyone with a shell on it can already
  do everything grokrc can. grokrc does not defend against local attackers.
- **Grok Build itself is trusted.** grokrc drives it over ACP; it does not sandbox it.
- **The operator chooses the network exposure.** Loopback by default; `--lan` and relay
  mode are deliberate opt-ins.

### What grokrc defends against

| Threat                                | Defence                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------- |
| Unpaired device connecting            | 6-character pairing code, 5-minute TTL, single use                          |
| Stolen pairing code replayed          | Codes are consumed on redeem; constant-time comparison                      |
| Token theft from disk                 | Only a hash is stored; the plaintext token is returned exactly once         |
| Brute-forced device token             | 256-bit tokens; sockets closed on a bad token (`close 4401`)                |
| A relay operator reading your session | AES-256-GCM end-to-end; the key travels in the URL **fragment**, never sent |
| One relay room reaching another       | Per-room ownership checks on every tunnelled request and response           |
| Malformed frames crashing the daemon  | Per-message shape validation before dispatch                                |
| Path traversal via session `cwd`      | `cwd` must be an existing absolute directory; validated on create and resume |
| Unbounded memory from a hostile agent | NDJSON lines capped at 8 MiB; live sessions capped at 12                    |
| Another local account reading `~/.grokrc` | POSIX: directory `0700`, files `0600`. Windows: an ACL granting only your account, with inherited entries dropped |

### Platform differences, stated rather than assumed

Two defences are genuinely weaker on Windows. Both are recorded here because a
threat model that only describes the strongest platform is not a threat model.

- **The control channel.** On Unix it is a socket file in your own directory,
  `chmod 0600` — access is filesystem permissions, and anyone who can open it
  already has your shell. Windows has no Unix domain sockets, so it is a named
  pipe; pipes are machine-global and Node exposes no way to set an ACL on one.
  The name is a SHA-256 of your config directory, so it is *unguessable* rather
  than *protected*. That is a real difference in kind.

- **`~/.grokrc` permissions.** POSIX modes are ignored on Windows, so the
  `mode: 0o700` the code asks for did nothing there and the directory simply
  inherited its parent's ACL. It is now hardened explicitly with `icacls`
  (`/inheritance:r` then a single grant to your account), and
  `test/config-dir.test.ts` proves it by giving a parent an inheritable grant to
  `BUILTIN\Users` and asserting the child does not keep it. In practice a
  Windows user profile is already restricted, so this was a weakened defence
  rather than an open door — but "probably fine by inheritance" and "owner-only"
  are different claims, and only one of them was true.

### What grokrc does **not** defend against

- **A compromised phone.** A paired device is a fully trusted client. If you lose the
  phone, run `grokrc revoke <id>` — or `grokrc revoke --all`.
- **A malicious relay denying service.** A relay cannot read or forge your traffic, but
  it can drop it. Run your own if that matters.
- **A relay that also serves you the client.** This is the sharpest limit here, so it is
  spelled out rather than buried. End-to-end encryption protects the payload — the key
  lives in the URL fragment, which browsers never transmit — but *the page's JavaScript
  is what decrypts*. A relay that serves the PWA can serve a modified one and read
  everything before encryption is ever applied.

  Subresource Integrity does not save you: the same relay serves `index.html`, so it can
  drop the `integrity` attribute, and code supplied by an attacker cannot meaningfully
  verify itself. **The only sound answer is to not take your code from a party you do
  not trust.**

  - Running a relay **for other people**: start it with `grokrc relay --no-client`. It
    becomes pure transport — it moves frames it cannot read and serves no JavaScript at
    all. Verified by `test/relay-transport-only.test.ts`, including that the transport
    keeps working when the client is refused.
  - Using **someone else's** relay: you are trusting their JavaScript. Treat that as
    equivalent to trusting them with the session.
  - Using **your own** relay on a host you control: this risk is yours to hold, and
    serving the client from it is reasonable.

  There is a possible mitigation that would remove the risk entirely: install the
  PWA once from the daemon's own origin over Tailscale, then let the installed
  application communicate with the relay. This has **not been tested** and is not
  currently a supported configuration.
- **Prompt injection into the agent.** If Grok reads a hostile file and decides to run
  something, grokrc faithfully relays the approval request. **Approvals are your
  control** — see below.
- **Anything at all if approvals are disabled.** See the next section.

## The approvals setting matters more than anything else here

Grok Build ships with permission prompting **off**:

```toml
[features]
support_permission = false
```

With that default, Grok never sends `session/request_permission`. Two consequences,
and the second is the dangerous one:

1. Remote approval buttons never appear — grokrc looks broken.
2. **The agent acts without asking anyone**, in the terminal and on your phone alike.

grokrc's `preflight` check detects this and warns on startup. Turn approvals on:

```toml
# ~/.grok/config.toml
[features]
support_permission = true

[ui]
permission_mode = "default"   # NOT "auto"
```

`permission_mode = "auto"` suppresses prompts even when `support_permission` is true.

## Network exposure — pick deliberately

| Mode                     | Who can reach the daemon        | Notes                                            |
| ------------------------ | ------------------------------- | ------------------------------------------------ |
| default (loopback)       | only this machine               | safest; phone needs a tunnel                     |
| `--lan`                  | anything on your local network  | pairing still required; use on trusted LANs only |
| Tailscale (`serve`)      | your tailnet only               | **recommended**; real HTTPS, no open ports       |
| `--relay <url>`          | anyone with the room + key      | daemon dials **out**; nothing is listening       |

Serving over plain HTTP on a hostile network exposes the device token in transit. Use
HTTPS — via Tailscale or a relay — for anything beyond loopback.

## Cryptography

- **Device tokens** — 256 bits from `crypto.randomBytes`, stored as a SHA-256 hash.
- **Pairing codes** — `crypto.randomInt` over an unambiguous alphabet, 5-minute TTL.
- **Relay E2E** — AES-256-GCM, key derived with HKDF-SHA256 from a fragment secret.
- **Web Push** — self-hosted VAPID keys, generated locally, never leaving the machine.

There has been no third-party audit. Treat the guarantees above as designed-and-tested,
not certified.

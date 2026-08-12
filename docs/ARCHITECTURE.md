# Architecture

How grokrc is put together. For install and daily use see [GUIDE.md](GUIDE.md).

---

## Topology

```
  Phone PWA  ── LAN / Tailscale ──►  grokrc daemon  ── ACP ──►  grok agent
       │                                  │
       └──── WSS relay (optional) ────────┘  (daemon dials OUT)
```

| Mode | Path |
|---|---|
| **Direct** | Phone → daemon over LAN or Tailnet |
| **Relay** | Phone → relay ← daemon (outbound). Relay does not parse ACP or hold session state |

---

## Why ACP

| Need | PTY approach | ACP |
|---|---|---|
| Waiting for approval? | Regex ANSI | `session/request_permission` |
| Approve tool | Keystrokes | Reply with `optionId` |
| Diffs / tools / plan | Scrape terminal | Structured `session/update` events |

The phone renders a real UI over a stable event model. When Grok’s wire format drifts, one normalizer layer changes — not the entire client.

---

## Session modes

| Mode | Source | Control |
|---|---|---|
| **Owned** | Daemon spawns `grok agent stdio` | Full |
| **Shared** | Leader / multi-client backend | Full; concurrent with `grokrc term` |
| **Observed** | Tail `~/.grok/sessions/…/updates.jsonl` | Read-only until **Take over** |

**Take over** — stop the registered owner process (when safe) and resume as owned.  
**Hand back** — close the daemon-owned agent, return resume commands, and attempt to open a desktop terminal with `grok -r <id>`.

---

## Event model

ACP frames (and observed logs) normalize to a small union the client renders:

| Kind | Role |
|---|---|
| `text` | User / agent message |
| `thinking` | Model reasoning (client may show only finalized blocks) |
| `tool` | Tool call lifecycle + optional diff |
| `plan` | Plan items |
| `approval` | Permission request + options |
| `status` | idle / working / awaiting-approval / … |
| `session` | Metadata (cwd, title, model, mode) |
| `error` | Failures |

Live traffic is filtered and size-capped so large tool payloads do not crash mobile browsers. Stored history on the machine can retain more detail for recovery.

---

## Components

```
src/
  acp/          JSON-RPC client, stdio transport, protocol types
  daemon/       HTTP + WebSocket server, sessions, auth, push, observer, control socket
  relay/        Optional forwarder
  term/         Terminal client
  cli.ts        grokrc entrypoint
web/            PWA (no framework build step)
packaging/      systemd (Linux), Scheduled Task (Windows)
```

---

## Security properties

1. **Pairing** — short-lived code → long-lived device token (hash stored)  
2. **Auth on every socket** — bad token closes the connection  
3. **Relay content-blind** — AES-GCM; key in URL fragment (not sent to relay)  
4. **Credentials stay local** — `~/.grok/auth.json` used only by the local agent  
5. **No silent auto-approve** — product does not start with bypass flags  
6. **Loopback by default** — exposure is opt-in (`--lan`, relay)

Details and reporting: [SECURITY.md](../SECURITY.md).

---

## Build order (historical)

1. ACP client over stdio  
2. Event normalizer  
3. Session manager (owned / shared / observed)  
4. WS server + pairing  
5. PWA  
6. Relay  
7. Web Push  

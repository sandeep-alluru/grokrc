# Even Realities G2 client

A third client for the grokrc daemon, alongside the phone PWA and `grokrc term`.
It runs on [Even Realities G2](https://www.evenrealities.com) smart glasses: the
turn is read on the lenses, tool approvals are one tap, and typed prompts happen
on the phone.

Code lives in [`glasses/`](../glasses/); that directory's README is the
developer guide. This document records **why** it is shaped the way it is, and
what changed in the daemon to allow it.

---

## Topology

```
  Glasses  ── Bluetooth ──►  Phone (Even Hub app)
                                │
                                │  wss  (Tailscale / LAN)
                                ▼
                          grokrc daemon  ── ACP ──►  grok agent
```

The glasses run no code. They are a 576 × 288 monochrome display driven over
Bluetooth by the Even Hub app on the phone, which loads the web app. So the
client is an ordinary browser bundle that happens to paint a heads-up display
and read a four-gesture touchpad.

## What changed in the daemon

One message, and one limit. Everything else the glasses need already existed.

### `{t:'pair', code}` — pairing over the WebSocket

**The problem.** The PWA pairs with `POST /api/pair`, which works because the
daemon *serves* the PWA — same origin. An installed `.ehpk` is served by the
Even Hub host, so it is a foreign origin, and the browser blocks that fetch
before it leaves the device. There is no CORS handling on `/api/*` at all
(`OPTIONS /api/pair` returns 404).

**Why not just add CORS.** Adding `Access-Control-Allow-Origin` to `/api/pair`
would let *any* page the owner visits attempt pairing from their browser. That
widens a security-relevant endpoint for every caller, to serve one client.

**What was done instead.** WebSockets are not CORS-gated, and the glasses client
is opening a socket anyway. So pairing rides it:

```
glasses -> { t: 'pair', code: 'ABC123', deviceName: 'Even Realities G2' }
daemon  -> { t: 'paired', token: '…', device: { id, name } }
glasses -> { t: 'hello', token: '…' }        // still the only auth path
```

`pair` does **not** authenticate the socket. The client sends `hello` with the
new token exactly as any other client would, so there remains exactly one place
that sets `client.device`.

Note this does not make the daemon newly reachable: the WebSocket server already
accepted cross-origin connections with no Origin check, and always has. Device
tokens are 32 random bytes, so that was never brute-forceable. What `pair` adds
is a **short** secret on that channel — hence the limit below.

### `MAX_PAIR_ATTEMPTS` — five wrong codes per connection

A pairing code is six characters from a 31-character alphabet. Wide, but not
unlimited-guessing wide, and nothing capped attempts before now.

The counter lives on the **connection** (`Client.pairFails`), not globally.
That distinction was learned the hard way:

> The first attempt counted failures globally in `AuthStore.redeem` and cleared
> every outstanding code after ten misses. `test/pairing-codes.test.ts` failed
> immediately — its bounds test issues 30 codes and redeems all 30, so the 22
> legitimate misses from evicted codes burned the 8 live ones. The same flaw
> would hit a real owner: fat-finger a code ten times and you destroy the code
> you were about to type.

Counting per socket costs an attacker a reconnect per attempt, and never touches
the owner's outstanding codes. `AuthStore` is unchanged.

## What the glasses client does NOT need

- **No new HTTP routes.** `/api/*` is untouched.
- **No changes to `AuthStore`.**
- **No changes to the event model.** `RcEvent` is rendered as-is.
- **No relay changes.** The client speaks direct-mode only for now.

## Design notes worth keeping

**Four gestures, and that is the whole budget.** Tap, double-tap, swipe up,
swipe down. No keyboard, no pointer. The R1 ring emits identical event codes, so
ring support is free and needs no branch in the code.

| View | scroll | tap | double-tap |
|---|---|---|---|
| sessions | move cursor | open | exit app |
| session | page transcript | jump to newest | back to list |
| approval | choose option | confirm | back to session |

Double-tap is always "back", and backs out of the list by exiting the app, so
the wearer can always leave from anywhere.

**Approvals are the reason this is interesting.** `RcEvent` already carries
`{k:'approval', options[{id,label,intent}]}`, and grokrc already round-trips
`{t:'approve', optionId}`. Approving a tool call by tapping a ring, without
taking your laptop out, is something the phone PWA cannot do more conveniently
than the glasses can.

**`glasses/src/rc/protocol.ts` is a hand-kept mirror** of `ClientMsg` and
`RcEvent`. The daemon is Node-targeted (NodeNext, `.ts` specifiers, server-only
imports) and the client is a browser bundle; importing across that boundary
drags the daemon graph into a WebView. The copy is type-only and small, and the
compiler caught drift the first time a message was added on one side.

**Persistence must use the SDK's storage.** The Even Hub WebView does not keep
browser `localStorage` across an app exit, so a device token stored there is
gone every launch and the app demands re-pairing forever.
`bridge.setLocalStorage` survives. See `glasses/src/lib/store.ts`.

**The daemon URL must be configured, and must be `wss`.** An installed build
cannot derive it — `location` is the Even Hub host. And a secure page may not
open a plain `ws://` socket; that is a browser rule and it fails before any
traffic leaves the device. Tailscale (`tailscale serve --bg --https=…`) is the
easy way to get a real certificate on a machine at home.

## Status

| | |
|---|---|
| Typecheck | passes (daemon and client) |
| Daemon suite | 298/301 — see below |
| Real G2 hardware | **never run** |
| Voice input | not implemented |

The three non-passing entries at time of writing: two pre-existing skips, and
`verify-guards` failing on `busy-not-derived-from-history` — that guard pins a
two-line pattern in `web/app.js` which the mid-turn-interrupt work moved. It is
unrelated to the glasses client; the guard's `find` in `tools/guards.mjs` needs
re-pinning to the new code.

**Nothing here has run on real hardware.** The display, gesture routing and
reconnect logic are unproven on a device. That matters more than it sounds:
packaged-app behaviour — storage lifetime, foreign origins, mixed content — is
exactly the class of bug that neither the simulator nor a desktop browser
reproduces.

## Licence

MIT, as the rest of grokrc. The G2 voice/compose interaction was informed by
[ThatCrispyToast/g2-claude-remote](https://github.com/ThatCrispyToast/g2-claude-remote)
(MIT, © 2026 Aniket Chadalavada). No code from that project is copied here.

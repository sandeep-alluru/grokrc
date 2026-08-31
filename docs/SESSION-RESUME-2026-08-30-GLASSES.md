# Session resume — G2 glasses client for grokrc

**Date:** 2026-08-30 · **Branch:** `glasses-g2` (4 commits ahead of `main`)
**Machine:** clawer-samurai-1 · **Session:** `c6d960aa-d249-41ff-a198-677fc147dec6`

For future Claude / Grok / Codex picking this up cold.

---

## State at handoff

Branch `glasses-g2`, working tree **clean**, suite **299 pass / 0 fail / 2 skipped**.

```
35692b7  Re-pin the busy-state guard to the line the control still sits on
2610b07  Add an Even Realities G2 client
d2845b3  Let a foreign-origin client pair over the WebSocket
6eaee5d  Keep the composer usable across a mid-turn follow-up   <- owner's work
b320721  (main) Add owner feedback ledger and craft notes.
```

`6eaee5d` was the owner's uncommitted working tree, committed unmodified. It is
their code, not Claude's — no co-authorship trailer on that one.

**Not merged to `main`. Not pushed. Never run on real G2 hardware.**

## What this branch adds

A third client beside the phone PWA and `grokrc term`: Even Realities G2
glasses. Read the turn on the lenses, approve tool calls with one tap, type
prompts on the phone. Full design rationale in
[`docs/GLASSES-G2.md`](GLASSES-G2.md); developer guide in
[`glasses/README.md`](../glasses/README.md).

Daemon change is one message and one limit — see `d2845b3`. Everything else the
glasses need already existed in the protocol.

## Verified (command → result)

| Claim | How it was checked |
|---|---|
| Daemon typechecks | `npm run typecheck` → exit 0 |
| Glasses typecheck + build | `cd glasses && npm run build` → exit 0, 219 kB bundle |
| Suite green | `npm run test:suite` → 301 tests, 299 pass, 0 fail |
| Guard load-bearing | `node tools/verify-guards.mjs --only busy-not-derived-from-history` → baseline pass, mutation fails, source restored |
| Protocol read, not guessed | `ClientMsg` at `src/daemon/server.ts:40`, `RcEvent` at `src/daemon/events.ts:19` |
| Daemon needs no CORS | `curl -X OPTIONS http://127.0.0.1:4319/api/pair` → 404, no ACAO header |
| Ring works for free | `handle-input` SDK docs: R1 emits identical `CLICK`/`DOUBLE_CLICK` codes |

## NOT verified — the honest list

- **Nothing has run on real G2 hardware.** Display, gesture routing, reconnect
  after phone sleep, and the approval flow are all unproven on a device.
- **The glasses client has never talked to a live daemon.** It typechecks
  against the protocol, which is not the same thing.
- **No automated test covers `glasses/`.** The daemon side of `{t:'pair'}` has
  no test either — it should get one.
- **Voice input is not implemented.**
- **Relay mode is not implemented** — direct mode only.

## Two mistakes worth not repeating

**1. The limiter in the wrong place.** First attempt counted failed pairing
codes globally in `AuthStore.redeem` and cleared all pending codes after ten
misses. `test/pairing-codes.test.ts` failed instantly: its bounds test issues 30
codes and redeems all 30, so 22 honest misses from evicted codes burned the 8
live ones. The same flaw would hit a real owner — mistype ten times and you
destroy the code you were about to use. Fixed by counting per connection
(`Client.pairFails`), which is also the shape that actually matches the threat:
brute force is many attempts down one socket. **The existing test caught a real
design flaw, not a technicality.**

**2. Packaged-app behaviour is invisible in dev.** Three bugs during the day's
earlier work on a separate Claude client — all in `AgentHub/even-realities` —
were properties of the *installed* app that neither the simulator nor a desktop
browser reproduces:

- URL derived from `location` is meaningless in an installed `.ehpk`
- browser `localStorage` does not survive an app exit in the Even Hub WebView
- a secure page cannot call `http://` or open `ws://` (mixed content)

All three are now designed around in `glasses/`, but they were learned by
shipping broken builds three times. **Test packaged early, not last.**

## Next steps, in order

1. **Pack and sideload.** `cd glasses && npm run pack` → upload the `.ehpk` to
   the Even Hub dev portal under *Private builds* → install from the phone.
   Bump `version` in `glasses/app.json` every upload or the phone sees nothing
   new to install.
2. **Expose the daemon over TLS.** The client needs `wss`. On this machine
   Tailscale already does it:
   `tailscale serve --bg --https=<port> http://127.0.0.1:4319`
3. **Pair.** `grokrc pair` on the machine → enter the 6-char code in the phone
   panel, after setting *Daemon address*.
4. **Then** the unknowns become answerable: does the display render, do gestures
   route, does it survive the phone sleeping, does an approval round-trip.
5. Add a daemon test for `{t:'pair'}` and the attempt cap.
6. Consider voice (Deepgram, as the Claude G2 app does it) once the above works.

## Related work on this machine

`AgentHub/even-realities` — a separate, now-superseded Claude Code client for
the G2, built earlier the same day before discovering that a better third-party
app already existed in the Even Hub store. Its `docs/NEXT-STEPS.md` carries the
packaged-app lessons above in more detail, plus the Tailscale layout. The
owner's working Claude-on-glasses setup uses
[ThatCrispyToast/g2-claude-remote](https://github.com/ThatCrispyToast/g2-claude-remote),
not that build.

## Rollback

Nothing here touches `main`. To drop the whole branch:

```bash
git checkout main && git branch -D glasses-g2
```

To keep the owner's mid-turn-interrupt work but drop the glasses client, cherry-pick
`6eaee5d` onto `main` and discard the rest.

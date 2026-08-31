# Owner feedback — 2026-08-22 (open)

Source session: `01a02a0a-8462-7e62-befc-bafca7e04261` (Review grokrc for phone active sessions).

These items lived only in the conversation until retroactively ledgered on 2026-08-22.

## F1 — Active sessions stay on the phone
**Owner:** "make sure on active sessions stay in the phone"

**Intent:** Phone list should surface live/active sessions and not bury them under stale past sessions.

**Related prior:** repeated "remove stale / clear non-active" requests (Aug 15–20).

**Status:** Config workaround used (`historyLimit=0` → only actives). Product fix still open (active-first / hide-stale default, not only config).

## F2 — Send follow-up while turn is running
**Owner:** "we already sent one message and want to send another then we have to wait till every thing completes so I can’t sent another message and can’t click stop so we need feature to send new message"

**Intent:** Queue or send a new prompt without waiting for full turn completion; Stop must remain usable.

**Status:** open (feature). Uncommitted WIP may touch related UI but this specific queue/interrupt path is not verified done.

## F3 — Stop stuck + progress/completed indicator
**Owner:** "stop button seems to be stuck … even when agent turn completed … have a progress or something that agent is still in progress … completed"

**Intent:**
1. Busy/Stop must clear on real turn completion (no re-stick from late thinking/tool updates).
2. Visible Working / Done (or progress) so the phone is not ambiguous.

**Status:** partial — uncommitted changes in `web/app.js`, `web/index.html`, `src/daemon/session-manager.ts`, `test/busy-state.test.ts`, `test/prompt-interrupt.test.ts`. Review session todo left deploy + browser verify incomplete.

## Capture gap
`FEEDBACK-LEDGER.jsonl` last prior entry was 2026-08-16. Today’s three prompts were **not** in the ledger until this file + ledger append.

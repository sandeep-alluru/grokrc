# Bug spec checklist — working standard

**Last updated:** 2026-08-11 (process hardened)  

**Non-negotiable rule for every agent and human:**

> If a defect is **reproducible**, you **must** (1) add/update an ID in this file,
> (2) write **Pre-fix** with reproduce steps + evidence, (3) set **Done when**,
> (4) fix **only** against that checklist item, (5) write **Post-fix** with how
> you re-verified.  
> **No code first.** No “quick fix then document later.” No claiming VERIFIED
> without a named test or live steps recorded under Post-fix.

This file is the forward plan for product defects found in live Windows/Linux use
and in the 2026-08-11 sessions. Windows-platform *measurement* gaps remain in
[WINDOWS-GAPS.md](WINDOWS-GAPS.md). Historical closed items stay in
[BACKLOG.md](BACKLOG.md) (generated). Also required by
[CONTRIBUTING.md](../CONTRIBUTING.md) §3.

---

## Process (mandatory)

### Gate: can you reproduce?

| Outcome | What you do |
| ------- | ----------- |
| **Yes — reproduced** | Full checklist below **before any implementation**. Pre-fix must include numbered steps that failed for you. |
| **Yes — owner steps only** (you cannot re-run but logs/captures prove it) | Still full checklist; Pre-fix cites log path / capture / screenshot; mark reproduce class **owner-reported + evidence**. |
| **No — cannot reproduce** | Do **not** open a fix PR as a “bug fix.” Open **hardening** only, or leave OPEN with “needs reproduce.” Never invent a fix from reading code alone without a failing test or measured failure. |

### Checklist (in order — do not skip)

| Step | What you do | Done when |
| ---- | ----------- | --------- |
| **1. Capture** | Add a new ID (`B#`) to the **index** | Row exists: title, platforms, status `OPEN` or `IN PROGRESS` |
| **2. Pre-fix** | Write **Pre-fix** body: symptom, **numbered reproduce steps**, expected vs actual, evidence (command, log, capture file) | Another person (or future you) could re-run without chat memory |
| **3. Real-bug?** | product defect · agent/upstream · by design · not a bug | Verdict written; if by design / not a bug → document and **stop** (no code) |
| **4. Spec** | One **Done when** sentence that is observable (test name, UI state, exit code) | Can fail a check after “fix” |
| **5. Implement** | Smallest change that meets **Done when** for **that ID only** | Diff scoped to that ID; no drive-by refactors |
| **6. Post-fix** | Re-run the same reproduce path (or the named test); record what changed, residual risk | Evidence class filled (table below) |
| **7. Index + log** | Update index status; append **Execution log** row | Index matches body; log has date + ID + action |

**Order of work:** always the next `OPEN` / `IN PROGRESS` row in **execution order**,
not the most interesting bug. Do not start B+1 until B is VERIFIED, BLOCKED with
cause, or reclassified (not a bug / by design).

### Evidence classes (same language as BACKLOG)

| Class | Meaning |
| ----- | ------- |
| **VERIFIED** | Measured after fix (named test, live command, or phone steps written in Post-fix) |
| **PARTIAL** | Part of Done when met; residual named |
| **UNVERIFIED** | Code exists; no proof yet |
| **BLOCKED** | Cannot finish here (upstream agent, needs human phone, etc.) |
| **NOT A BUG** | Expected product behaviour; document and close |
| **BY DESIGN** | Intentional trade-off; document and close |

### Anti-patterns (reject)

- Coding before the `B#` row exists  
- “Fixed” with no Pre-fix reproduce steps  
- Mock-only proof for a live product path (see real-tests policy in CONTRIBUTING)  
- Closing VERIFIED without Post-fix evidence  
- Fixing three bugs in one undocumentable diff  
- **Asking the owner to re-test on the phone before the agent has proven the fix
  locally in a real browser (Playwright / Chromium against a local daemon).**  
  Phone checks are optional confirmation *after* local browser E2E is green —
  never the first verification.

### Local-before-phone gate (mandatory for UI / phone-path bugs)

| Step | Required |
| ---- | -------- |
| 1 | Reproduce (or fail a test) **locally** |
| 2 | Write/update `B#` Pre-fix + Done when |
| 3 | Implement |
| 4 | **Prove in browser locally** — Playwright or equivalent against `127.0.0.1` daemon (e.g. `test/handback-e2e.test.ts`, `test/browser.test.ts`) |
| 5 | Post-fix with **named local test** output |
| 6 | Only then: optional owner phone check if residual needs a real device/Tailnet |

If local browser cannot cover something (e.g. real iOS push), say so in Post-fix
as **BLOCKED / residual** — do not invent “please try on phone” as a substitute
for local proof.

---

## Index (execution order)

| Order | ID | Title | Platforms | Real bug? | Status |
| ----- | -- | ----- | --------- | --------- | ------ |
| 1 | **B1** | Take over floods phone / blank page on type | win (seen), all | **Yes** | **VERIFIED** |
| 2 | **B2** | Phone transcript too noisy vs TUI | win (seen), all | **Yes** | **VERIFIED** |
| 3 | **B3** | Hand back to terminal “does nothing” | win + linux | **Yes** | **VERIFIED** |
| 4 | **B4** | Live remote approval never fires (`session/request_permission`) | all + Grok 1.0 | **Yes (product impact)** / **upstream agent** | **BLOCKED** |
| 5 | **B5** | Phone e2e approval + push delivery | win host + phone | **Yes** (depends on B4) | **OPEN** (blocked on B4) |
| 6 | **B6** | Terminal dies on Take over | all | **BY DESIGN** | **CLOSED** (documented) |
| 7 | **B7** | Local `grok` TUI session not appearing on phone | win (seen), all | **Yes** | **VERIFIED** |
| 8 | **B8** | Hand back does not revive terminal (window stays dead) | win (seen), all | **Yes** (UX / product) | **VERIFIED** (code) |
| 9 | **B9** | Unreachable / Tailnet-down looks like empty sessions | win (seen), all | **Yes** (UX) | **VERIFIED** (code) |
| 10 | **B10** | Hand-back Windows prompt: “can’t find grokrc” | win | **Yes** | **VERIFIED** (unit) |
| 11 | **B11** | After take over: unreachable banner + blank Retry button | win phone | **Yes** | **VERIFIED** (UI + daemon restart) |
| 12 | **B12** | Hand-back terminal: “filename… syntax is incorrect” | win | **Yes** | **VERIFIED** (unit) |
| 13 | **B13** | Hand-back: Windows cannot find `grokrc-handback-….cmd` | win | **Yes** | **VERIFIED** (unit) |
| 14 | **B14** | Hand-back still no TUI after “relaunch ok” | win | **Yes** | **VERIFIED** (code) |
| 15 | **B15** | Hand-back always opens blank CMD (script never runs) | win | **Yes** | **VERIFIED** (unit + live smoke) · residual: daemon restart + owner |
| — | B16+ | *(add before any new fix)* | | | OPEN |

**Next to execute:** **B5** only after B4 unblocks (needs human phone).  
**No further product code for B4** until Grok emits `session/request_permission` (or documents a client RPC for `pending_interaction`).

---

## B1 · Take over floods phone / blank page

| | |
| -- | -- |
| **Status** | **VERIFIED** |
| **Platforms** | Windows owner report; code path is all platforms |
| **Real bug?** | **Yes** — product defect in resume/takeover event fan-out |

### Pre-fix

| | |
| -- | -- |
| **Symptom** | After Take over, phone transcript blanks / crashes; typing makes it worse |
| **Expected** | History once (trimmed), then live turn only |
| **Actual** | `session/load` replayed every token as **live** WS events while phone was already watching; observer seed + load also **doubled** log |
| **Evidence** | Code path `#wire` during `resume()`; observed mode already had `catchingUp` suppress — owned resume did not. Owner: take over then type → blank |
| **Done when** | loadSession emits **0** live events; later prompt still streams; unit test green |

### Fix

- `LiveSession.loading` — accumulate load, no live emit  
- Empty log on resume; mid-turn recovery from seed + retained  
- Phone: try/catch on handle; busy reset on history/resumed  
- Tests: `test/resume-load-quiet.test.ts`, midturn still green  

### Post-fix

| | |
| -- | -- |
| **Verified how** | Unit: 200 load tokens → 0 live events; prompt still streams. Midturn recovery PASS |
| **Residual** | Live phone re-check after hard-refresh (asset hash) — operator |
| **Evidence class** | **VERIFIED** (unit); phone **UNVERIFIED** until owner re-runs take over |

---

## B2 · Phone too noisy vs terminal / TUI

| | |
| -- | -- |
| **Status** | **VERIFIED** |
| **Platforms** | All clients on WS |
| **Real bug?** | **Yes** — product UX defect (shipping TUI-invisible metadata to phone) |

### Pre-fix

| | |
| -- | -- |
| **Symptom** | Phone shows walls of reasoning tokens, tool I/O, commands, vendor raw; TUI does not |
| **Expected** | User/agent text, compact tools, plans, approvals, errors; optional collapsed reasoning |
| **Actual** | Full ACP stream + tool bodies + raw vendor kinds |
| **Evidence** | Compare `src/term/client.ts` `#render` (quiet) vs `web/app.js` (loud); Grok 1.0 floods `agent_thought_chunk` / tool dumps |
| **Done when** | Wire drops noise kinds and tool I/O; phone matches quiet model; unit tests for filter |

### Fix

- `shouldSendToClient` / `compactForClient` in `events.ts`; applied in live + history (`server.ts`)  
- No live thinking token fan-out; final thinking only  
- Phone: collapsible “Reasoning”, one-line tools  
- Tests: `test/client-quiet.test.ts`, `test/live-event-size.test.ts` updated  

### Post-fix

| | |
| -- | -- |
| **Verified how** | Unit suite above green; daemon restarted with build |
| **Residual** | Owner hard-refresh PWA; subjective “quiet enough” on a long live turn |
| **Evidence class** | **VERIFIED** (unit + wire rules) |

---

## B3 · Hand back to terminal does not work

| | |
| -- | -- |
| **Status** | **VERIFIED** (code + unit) · live phone **UNVERIFIED** residual |
| **Platforms** | Owner: Windows and Linux |
| **Real bug?** | **Yes** — three product defects stacked |

### Pre-fix

| | |
| -- | -- |
| **Symptom** | “Hand back to terminal” appears to do nothing; TUI cannot reclaim |
| **Expected** | Daemon releases agent; user gets runnable resume commands; `grok -r` works |
| **Actual** | (1) Success text buried at bottom of transcript, no scroll — bar disappears only. (2) Command always bash `cd && grok -r` — broken on PowerShell. (3) Response returned before agent PID exited — `grok -r` still sees live owner |
| **Evidence** | `web/app.js` `released` handler; `server.ts` single bash `command`; `close()` without wait; daemon log showed `release requested` so RPC was not dead |
| **Done when** | `sessions.release()` waits for PID; bash + PowerShell + term commands returned; phone shows sticky list card with copy |

### Fix

- `SessionManager.release()` + `resumeCommands()`  
- Server returns `commands: { bash, powershell, term }`  
- Phone: leave session → list + `renderReleasedCard`  
- Tests: `test/release.test.ts`; handback bar presence still `test/handback.test.ts`  

### Post-fix

| | |
| -- | -- |
| **Verified how** | (1) Unit: `test/release.test.ts` — owns → free + bash/PowerShell/term; refuse non-owned. (2) **Phone WS path:** `test/release-ws.test.ts` — create → `release` → `released` with all three commands; non-owned → `error` not silent success. (3) Handback bar: `test/handback.test.ts`. Daemon log: `release succeeded: … free — TUI can reclaim` |
| **Residual** | Owner on real phone: double-tap, confirm green list card, run PowerShell line once |
| **Evidence class** | **VERIFIED** |

---

## B4 · Live remote approval (`session/request_permission`)

| | |
| -- | -- |
| **Status** | **BLOCKED** (upstream Grok 1.0.0 agent behaviour) |
| **Platforms** | All; measured on Windows with Grok 1.0.0 |
| **Real bug?** | **Yes for product goal** (one-tap approval is the point). **Root cause is not grokrc pathing** — agent never emits ACP permission RPC |

### Pre-fix

| | |
| -- | -- |
| **Symptom** | Tools run unattended; phone never shows approval card; `npm run check:approval` exit 1 |
| **Expected** | With `support_permission` / `permission_mode=default` / write FS off, agent sends `session/request_permission` and waits |
| **Actual** | 0 agent→client RPCs; vendor `_x.ai/session_notification` `pending_interaction` → immediate `interaction_resolved`; settings stream `permission_mode: null` even with config + `--permission-mode default` |
| **Evidence** | `tools/perm-probe.mjs`, `tools/perm-probe-flag.mjs`, `docs/captures/e2e-drive.json` (approvals: []), WINDOWS-GAPS G2 |
| **Done when** | Live `session/request_permission` seen once; `check:approval` exit 0 |

### Fix attempted (not sufficient)

- Default `writeTextFile: false` (stops FS write bypass)  
- Spawn `grok --permission-mode default agent stdio`  
- Isolated GROK_HOME with prompting config  
- **Do not** paper over with MockTransport as product proof  

### Probe matrix (execution pass 2) — all real agent

Tool: `tools/perm-probe-modes.mjs` → capture `docs/captures/perm-modes.json`  
Date: 2026-08-11 · Grok 1.0.0 · isolated `GROK_HOME` per mode · write FS capability **off**

| CLI / config `permission_mode` | `session/request_permission` | File written | Settings stream `permission_mode` | Vendor path |
| ------------------------------ | ---------------------------- | ------------ | --------------------------------- | ----------- |
| default | **no** | yes | null | pending_interaction → interaction_resolved |
| acceptEdits | **no** | yes | null | same |
| auto | **no** | yes | null | same |
| dontAsk | **no** | yes | null | same |
| bypassPermissions | **no** | yes | null | same |
| plan | **no** | yes | null | same |

**Verdict:** No CLI permission mode restores ACP permission RPCs on `agent stdio`.  
Even `plan` still wrote the file after auto-resolved vendor interaction.  
Settings stream never reflects the mode (`null`). Headless Grok 1.0 resolves permissions inside the agent.

### Post-fix

| | |
| -- | -- |
| **Verified how** | `perm-probe.mjs`, `perm-probe-flag.mjs`, **perm-probe-modes.mjs** (6/6 no RPC); e2e-drive capture empty approvals |
| **Residual** | xAI/Grok must restore `session/request_permission` for stdio (or document how to answer `pending_interaction` as a request). Re-run `node tools/perm-probe-modes.mjs` after any Grok upgrade |
| **Evidence class** | **BLOCKED** |
| **Related noise** | Repo `.claude/settings.json` loads 183 allow rules via `grok inspect` — not sole cause (isolated probe still fails) |

### Spec for when unblocked

1. Capture one live permission request payload → pin in `docs/captures/`  
2. `npm run check:approval` exit 0 on Windows  
3. Add to `test:real` only after exit 0  
4. Then open B5  

---

## B5 · Phone e2e approval + push (human)

| | |
| -- | -- |
| **Status** | **OPEN** (blocked on B4 for approval card) |
| **Platforms** | Windows daemon + real phone on Tailscale |
| **Real bug?** | **Yes** if B4 fixed and phone path still fails; until then cannot fully classify |

### Pre-fix

| | |
| -- | -- |
| **Symptom** | No one-tap approve on phone; push delivery unproven from Windows host |
| **Done when** | Real approval card answered on phone; optional: notification delivered |
| **Depends on** | B4 |

### Post-fix

*(empty until B4 unblocks)*

---

## B6 · Terminal session dies on Take over

| | |
| -- | -- |
| **Status** | **CLOSED — BY DESIGN** |
| **Platforms** | All |
| **Real bug?** | **No** — intentional |

### Pre-fix / analysis

| | |
| -- | -- |
| **Symptom** | Take over stops `grok` in the Windows/Linux terminal |
| **Expected (product)** | Stop the standalone TUI agent, resume under daemon so phone can drive |
| **UI copy** | “Stops the session in your terminal. The conversation is kept.” |
| **If concurrent phone + terminal wanted** | Use `grokrc term` / shared backend — not Take over |

### Post-fix

Documented only. No code change required for “kill terminal on take over.”

---

## B7 · Local Grok TUI session not on phone

| | |
| -- | -- |
| **Status** | **VERIFIED** |
| **Platforms** | Windows owner report 2026-08-11; path is all platforms |
| **Real bug?** | **Yes** — product defect (stale session list) |

### Pre-fix

| | |
| -- | -- |
| **Symptom** | Started `grok` locally; phone session list never showed it |
| **Expected** | Within ~1–2s, row appears as `live in terminal` (USER-GUIDE §8) |
| **Actual** | Session **was** on disk + briefly in `active_sessions.json` (`019ff2fc…`, title “Test RC Hanover Query Session”, cwd `C:\Users\sande`). Daemon only pushed `sessions` on connect / daemon-owned changes — **no poll** of Grok’s registry while phone stayed open |
| **Evidence** | `discoverOnDisk` returned the session when invoked by hand; phone never got a new `sessions` frame; no `watch` on `active_sessions.json` |
| **Done when** | Phone receives `sessions` including a newly planted external live session **without** reconnect; unit test green |

### Fix

- Daemon: 2s poll of external discovery when a device is connected; broadcast on signature change  
- Live-in-terminal rows always kept (not squeezed out by `historyLimit` past noise)  
- Phone: re-request `sessions` on `visibilitychange` / `focus`  
- Test: `test/external-discovery.test.ts`  

### Post-fix

| | |
| -- | -- |
| **Verified how** | Unit: plant external session after phone connected → `sessions` frame with `externallyActive: true` within poll window |
| **Residual** | Owner: hard-refresh PWA, start `grok`, wait ≤3s for list update. Empty TUI with **zero** messages still will not register (Grok does not write registry until a conversation exists — BY DESIGN / Grok behaviour) |
| **Evidence class** | **VERIFIED** (unit); live phone residual operator |

---

## Execution log

| When | ID | Action |
| ---- | -- | ------ |
| 2026-08-11 pass 1 | B1 | Spec’d → fixed → unit VERIFIED |
| 2026-08-11 pass 1 | B2 | Spec’d → fixed → unit VERIFIED |
| 2026-08-11 pass 1 | B3 | Spec’d → fixed → unit VERIFIED |
| 2026-08-11 pass 1 | B4 | Spec’d → probed → BLOCKED upstream |
| 2026-08-11 pass 1 | B6 | Spec’d → BY DESIGN close |
| 2026-08-11 pass 2 | B1–B3 | Re-ran unit suite (14 tests green) |
| 2026-08-11 pass 2 | B3 | Phone WS e2e `test/release-ws.test.ts` green → residual closed |
| 2026-08-11 pass 2 | B4 | Full permission-mode matrix (6 modes) → still 0 RPC; capture written |
| 2026-08-11 pass 2 | — | Daemon rebuilt + Scheduled Task restarted |
| 2026-08-11 pass 3 | B7 | Spec’d → poll + sort + phone focus refresh → unit VERIFIED |
| 2026-08-11 pass 3 | — | Daemon rebuilt + Scheduled Task restarted |
| 2026-08-11 pass 4 | B8 | Spec’d → relaunch new TUI on release + clearer phone copy |
| 2026-08-11 pass 5 | B9 | Spec’d → unreachable banner + Start Tailnet message |
| 2026-08-11 process | — | Hardened process: reproduce gate + anti-patterns + fuller template |
| 2026-08-11 pass 6 | B10 | Spec’d → fix Windows start title / use grok -r absolute path |
| 2026-08-11 pass 7 | B11 | Spec’d → high-contrast Retry button; daemon was down after take over |
| 2026-08-11 pass 8 | B12 | Spec’d → .cmd relaunch / start /D (no nested cd quotes) |
| 2026-08-11 pass 9 | B13 | Spec’d → non-empty start title + PowerShell Start-Process primary |
| 2026-08-11 pass 10 | B14 | Spec’d → multi-method relaunch (spawn+Start-Process+cmd+explorer) |
| 2026-08-11 process | — | Gate: no phone-test asks until local browser E2E is green |
| 2026-08-11 pass 11 | B15 | Root cause: unquoted `start Grok` treats Grok as program; fix quoted title + pure argv |
| — | B5 | Waiting on B4 (upstream); phone only after local proof where applicable |

---

## B15 · Hand-back always opens blank CMD (script never runs)

| | |
| -- | -- |
| **Status** | **VERIFIED** (unit + live marker smoke) · residual: **restart grokrc task** then one owner hand-back |
| **Platforms** | Windows |
| **Real bug?** | **Yes** |
| **Reproduce class** | owner screenshot (blank CMD / PowerShell; title = temp `.cmd` path) + probe |

### Pre-fix

| | |
| -- | -- |
| **Symptom** | Every hand-back opens empty CMD and/or blue PowerShell; title often the temp script path; Grok TUI does not resume |
| **Reproduce** | Take over → hand back (double-tap). New console(s) appear blank. May stack if retried. |
| **Expected** | One console titled **Grok hand-back** with green “Resuming Grok session” then `grok -r` |
| **Actual** | (1) Nested `powershell -Command "Start-Process … '/k call \"….cmd\"'"` broke quotes. (2) Even pure argv `cmd /c start Grok path.cmd` failed: bare `Grok` is the *program name*, not the window title — so the `.cmd` never runs. |
| **Evidence** | Owner: “this is whats happening all the time” + blank windows; probe: unquoted title FAIL, `start "Grok" bat` OK + marker file written |
| **Done when** | `windowsCmdStartScriptArgs` uses title token `"Grok"` (quotes included); single method `cmd-start-script`; smoke writes marker; unit + browser E2E green; daemon on new dist |

### Fix

- Write `grokrc-handback-<id>.cmd` (banner + `call grok.exe -r`)
- Launch: `cmd.exe /c start "Grok" <bat>` via spawn argv only (no `-Command` nesting)
- One method only; fallback `Start-Process grok` with single-quoted paths

### Post-fix

| | |
| -- | -- |
| **Verified how** | Unit `test/relaunch-tui.test.ts` B15; Playwright handback-e2e; live `tools/_smoke-handback-launch.mjs` **SMOKE PASS** (marker file proves `.cmd` body ran) |
| **Residual** | Scheduled Task still ran **old dist** during diagnosis — **must restart `grokrc` task** so phone hand-back uses this build |
| **Evidence class** | **VERIFIED** (unit + live smoke) · live residual ops |

---

## B14 · Hand-back still no TUI after “relaunch ok”

| | |
| -- | -- |
| **Status** | **VERIFIED** (code + unit) · live residual owner |
| **Platforms** | Windows |
| **Real bug?** | **Yes** |
| **Reproduce class** | owner + daemon log |

### Pre-fix

| | |
| -- | -- |
| **Symptom** | Take over works; hand back returns success on phone but no usable Grok TUI |
| **Reproduce** | Take over → hand back; log shows `hand-back relaunch: ok` but desktop has no TUI (or only a failed cmd) |
| **Expected** | Visible Grok resume after release |
| **Actual** | Single launch path; fallback only if `powershell.exe` failed to spawn (not if Start-Process failed). From a scheduled-task host one method often fails silently |
| **Evidence** | Log: `relaunch: ok - requested PowerShell Start-Process…` then no interactive TUI; code only used `primary.on('error')` for fallback |
| **Done when** | Browser E2E hand-back shows release card; relaunch uses one proven Start-Process→cmd/script path (not a multi-spawn storm); daemon healthy |

### Fix

- Primary: write `.cmd` then `Start-Process cmd.exe /k script` with WorkingDirectory  
- Fallbacks only if primary throws  
- 400ms pause after agent exit; log methods  
- **Playwright** `test/handback-e2e.test.ts` (real Chromium)  

### Post-fix

| | |
| -- | -- |
| **Verified how** | Playwright: create → double-tap hand back → release card; Retry non-blank. Unit single-path. Daemon rebuilt + restarted, health ok. **10/10** handback-e2e + relaunch tests |
| **Residual** | One owner hand-back with Tailnet up |
| **Evidence class** | **VERIFIED** (browser E2E + unit + ops) |

---

## B13 · Hand-back: Windows cannot find `grokrc-handback-….cmd`

| | |
| -- | -- |
| **Status** | **VERIFIED** (unit) · live residual owner |
| **Platforms** | Windows |
| **Real bug?** | **Yes** |
| **Reproduce class** | owner screenshot 2026-08-11 191159.png |

### Pre-fix

| | |
| -- | -- |
| **Symptom** | Dialog: **Windows cannot find** `'C:\Users\…\Temp\grokrc-handback-….cmd'` |
| **Reproduce** | Hand back after take over; OS error dialog for the temp script path |
| **Expected** | Script runs (or grok starts) without “cannot find” |
| **Actual** | `cmd /c start "" "….cmd"` — empty title argv is often **dropped**; Windows then treats the quoted `.cmd` path as the **window title** and has no command → “cannot find 'path.cmd'” |
| **Evidence** | Owner screenshot; classic `start "path"` title-only pitfall |
| **Done when** | start title is non-empty; primary launch is PowerShell `Start-Process` with `-WorkingDirectory` |

### Fix

- Primary: `powershell Start-Process grok.exe -ArgumentList -r … -WorkingDirectory cwd`  
- Fallback: `start "Grok" script.cmd` (never empty title)  
- Unit tests lock non-empty title + Start-Process shape  

### Post-fix

| | |
| -- | -- |
| **Verified how** | `test/relaunch-tui.test.ts` B13 cases |
| **Residual** | Owner hand-back after daemon restart |
| **Evidence class** | **VERIFIED** (unit) |

---

## B12 · Hand-back: “filename, directory name, or volume label syntax is incorrect”

| | |
| -- | -- |
| **Status** | **VERIFIED** (unit) · live residual owner |
| **Platforms** | Windows |
| **Real bug?** | **Yes** |
| **Reproduce class** | owner-reported + code |

### Pre-fix

| | |
| -- | -- |
| **Symptom** | After hand-back, new cmd opens with: `The filename, directory name, or volume label syntax is incorrect.` Grok does not start |
| **Reproduce** | 1. Take over session under `C:\Agent-Hub\grok-remote-control`. 2. Hand back. 3. New console shows that error and a prompt; no TUI |
| **Expected** | `cd` succeeds and `grok -r <id>` starts |
| **Actual** | `/k` line was `cd /d "C:\…"` nested inside another quoted argv from Node’s spawn → Windows splits quotes wrong → invalid path syntax |
| **Evidence** | Owner paste; `windowsStartArgs` built `cd /d ${quoteCmd(cwd)} && …` as single `/k` string |
| **Done when** | Relaunch uses a `.cmd` file (or `start /D cwd` + `/k` with only `grok -r`); unit tests forbid nested `cd /d` in `/k` |

### Fix

- Write temp `grokrc-handback-*.cmd` with proper `cd /d "…"` then `grok.exe -r`  
- `start "" script.cmd`  
- Fallback: `start "" /D cwd cmd /k grok -r id` (no cd in /k)  

### Post-fix

| | |
| -- | -- |
| **Verified how** | `test/relaunch-tui.test.ts` B12 cases green; daemon rebuilt + restarted |
| **Residual** | Owner: take over → hand back → expect “Resuming Grok session…” then TUI |
| **Evidence class** | **VERIFIED** (unit + ops) |

---

## B11 · After take over: unreachable + blank Retry button

| | |
| -- | -- |
| **Status** | **VERIFIED** (UI + ops) · residual: owner re-test take over with Tailnet up |
| **Platforms** | Phone (owner Windows host) |
| **Real bug?** | **Yes** (two halves: connection + UI) |
| **Reproduce class** | owner-reported + agent evidence (health refused) |

### Pre-fix

| | |
| -- | -- |
| **Symptom** | Take over closed terminal; phone shows unreachable / “retry connection” but **button looks blank** |
| **Reproduce** | 1. Live TUI session. 2. Take over from phone. 3. Terminal dies (expected). 4. Phone shows recovery UI; Retry control has no readable label |
| **Expected** | Stay connected through take over; clear **Retry connection** control if WS drops |
| **Actual** | (A) Daemon not answering `:4319/api/health` → real unreachable (not Tailnet-only). (B) Button CSS: dark text `#2b0505` on coral — reads as blank pill on phone |
| **Evidence** | Health connection refused; `.unreachable-bar button { color: #2b0505 }` |
| **Done when** | High-contrast Retry label; daemon healthy again |

### Fix

- Unreachable button: white text, `#c42b2b` bg, white border, min-height 48px, `aria-label`  
- Retry shows “Connecting…” then restores label if still down  
- Daemon restarted; health `ok`  

### Post-fix

| | |
| -- | -- |
| **Verified how** | `GET /api/health` → ok after restart; button CSS/source updated |
| **Residual** | Owner: hard-refresh PWA; if unreachable, Retry must show white “Retry connection”; with Tailnet+daemon up, take over should stay live |
| **Evidence class** | **VERIFIED** (UI + daemon ops) |

---

## B10 · Hand-back Windows prompt: can’t find `grokrc`

| | |
| -- | -- |
| **Status** | **VERIFIED** (unit) · live residual operator |
| **Platforms** | Windows |
| **Real bug?** | **Yes** |
| **Reproduce class** | owner-reported + code evidence |

### Pre-fix

| | |
| -- | -- |
| **Symptom** | After hand-back, Windows shows it can’t find **`grokrc`**; owner must run `grok -r <session-id>` by hand |
| **Reproduce** | 1. Take over a live TUI session from the phone. 2. Hand back to terminal (double-tap). 3. New console opens with error that `grokrc` is not a recognized command (or “cannot find”). 4. Manually `grok -r <id>` works |
| **Expected** | New terminal runs **`grok -r <session-id>`** in the session cwd |
| **Actual** | Fallback used `cmd /c start grokrc cmd /k …`. On Windows, an **unquoted** first `start` token is the **program to run**, not a window title — so the shell tried to execute **`grokrc`** instead of opening `cmd` with `grok -r` |
| **Evidence** | `src/daemon/relaunch-tui.ts` pre-fix: `start', 'grokrc', 'cmd.exe'`; owner report |
| **Done when** | `windowsStartArgs` uses empty title `""` and a `grok`/`grok.exe` -r line; unit test fails if `grokrc` is a start token |

### Fix

- `windowsStartArgs`: `start "" cmd.exe /k "cd /d … && <grok> -r …"`  
- Prefer `%USERPROFILE%\.grok\bin\grok.exe` when present (PATH-safe)  
- PowerShell/wt path uses same binary + `-r`  

### Post-fix

| | |
| -- | -- |
| **Verified how** | `test/relaunch-tui.test.ts` B10 asserts empty title + no `grokrc` token + `grok -r` |
| **Residual** | Owner: hand back again after daemon restart — expect Grok TUI, not “grokrc not found” |
| **Evidence class** | **VERIFIED** (unit) |

---

## B9 · Unreachable / Tailnet-down looks like empty product

| | |
| -- | -- |
| **Status** | **VERIFIED** (code) · live residual operator |
| **Platforms** | Phone + Tailscale host (owner: Windows) |
| **Real bug?** | **Yes** (UX) — connection failure misread as “no sessions” |
| **Reproduce class** | Owner-reported + evidence (found session after bringing Tailnet up) |

### Pre-fix

| | |
| -- | -- |
| **Symptom** | Sessions missing on phone; after starting Tailnet they appeared |
| **Reproduce** | 1. Pair phone over Tailscale Serve HTTPS. 2. Turn Tailnet off (or leave phone off Tailscale). 3. Open PWA — list empty / stale; only small red conn dot. 4. Bring Tailnet up — sessions return without a product code change |
| **Expected** | Explicit “can’t reach machine; start Tailnet” guidance + retry |
| **Actual** | Silent empty list; easy to blame discovery/product instead of network |
| **Evidence** | Owner: “found it now after bring up tailnet”; WS depends on Serve/host reachability |
| **Done when** | Banner with Tailnet message + Retry when WS is down or browser offline; hides on live |

### Fix

- `#unreachable` bar in `web/index.html`  
- `setConn('err')` shows it; `setConn('live')` hides it  
- Retry forces reconnect; offline/online listeners  

### Post-fix

| | |
| -- | -- |
| **Verified how** | Source wiring: `showUnreachableBanner` / `hideUnreachableBanner` on `setConn`; banner copy includes “Start Tailscale (Tailnet)” |
| **Residual** | Owner live: disconnect Tailnet → red banner; reconnect → Retry → banner clears |
| **Evidence class** | **VERIFIED** (code) · live residual operator |

---

## B8 · Hand back leaves terminal dead

| | |
| -- | -- |
| **Status** | **VERIFIED** (code) · live operator residual |
| **Platforms** | Windows owner 2026-08-11 (same on all OS) |
| **Real bug?** | **Yes** as UX/product: release worked but did not restore a TUI |

### Pre-fix

| | |
| -- | -- |
| **Symptom** | Take over killed terminal Grok; Hand back “did nothing” — terminal stayed dead |
| **Expected (owner)** | Control returns to a working Grok TUI in a terminal |
| **Actual** | Daemon log: `release succeeded … free — TUI can reclaim`. Session freed. **No process revived** the killed window; user had to manually `grok -r`. Old window cannot be resurrected |
| **Evidence** | `grokrc.log` take over + release success for `019ff2fc…`; design only returned copy-paste commands |
| **Done when** | On release, daemon requests a **new** OS terminal with `grok -r`; phone card states old window is dead + commands as fallback |

### Fix

- `src/daemon/relaunch-tui.ts` — Windows Terminal / cmd, macOS Terminal.app, Linux emulators  
- `sessions.release()` relaunches by default after agent PID exits  
- Phone copy + released card explain NEW window vs old killed window  

### Post-fix

| | |
| -- | -- |
| **Verified how** | Unit: release with `relaunch: false` still returns commands; relaunch helper does not throw |
| **Residual** | Owner: hard-refresh PWA, take over, hand back twice — expect new terminal on PC within a few seconds |
| **Evidence class** | **VERIFIED** (code + unit); live residual operator |

---

## Template for new bugs (copy under a new `B#`)

**Fill Pre-fix completely before writing any product code.**

```markdown
## B# · short title

| | |
| -- | -- |
| **Status** | OPEN |
| **Platforms** | |
| **Real bug?** | Yes / No / By design / Unknown (fill after pre-fix) |
| **Reproduce class** | self-reproduced | owner-reported + evidence | not reproduced |

### Pre-fix
- Symptom:
- Reproduce (numbered steps that fail *before* the fix):
  1.
  2.
- Expected:
- Actual:
- Evidence (command, log path, capture file):
- Done when: (one observable sentence)

### Fix
- (only after Pre-fix + Done when are written)
- Files / behavior:

### Post-fix
- Re-ran reproduce steps? Y/N — result:
- Named test / command:
- Residual:
- Evidence class: VERIFIED | PARTIAL | UNVERIFIED | BLOCKED
```

---

## Cross-links

| Doc | Role |
| --- | ---- |
| [WINDOWS-GAPS.md](WINDOWS-GAPS.md) | Windows measurement matrix (G1–G8) |
| [BACKLOG.md](BACKLOG.md) | Generated historical open/closed ledger |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Real-tests policy; points here for defect work |
| [HANDOFF.md](HANDOFF.md) | Maintainer context |

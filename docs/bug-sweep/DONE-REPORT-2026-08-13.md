# Bug-sweep done report · 2026-08-13

**Goal:** 0 bugs in last 2 consecutive full verification runs (agent-os directives).  
**Result:** **MET** — RUN-4 and RUN-5 each `gate_failures: 0`.

## Consecutive clean runs (evidence)

| Run | Finished (UTC) | gate_failures | Log |
|-----|----------------|---------------|-----|
| **RUN-4** | 2026-08-13T20:44:16Z | **0** | `docs/bug-sweep/runs/RUN-4/summary.txt` |
| **RUN-5** | 2026-08-13T20:52:23Z | **0** | `docs/bug-sweep/runs/RUN-5/summary.txt` |

Gates per run: G1 typecheck · G2 lint · G3 format · G5 suite · G4 build · G6 test:real · G7 verify:guards · G8 backlog · G9 stranger · G10 directive-check · G11 open REPRODUCED=0.

## Findings closed (all REPRODUCED settled)

| ID | Summary | Fix |
|----|---------|-----|
| F1 | eslint dead code / useless assignment | `web/app.js` |
| F2 | prettier drift (19 files) | `npm run format` |
| F3 | ACP pin missing `_x.ai/mcp/tools_changed` | `test/fixtures/acp-surface.json` |
| F4 | stale dist refuse | not a defect (harness correct) |
| F5 | guard restore bumped mtime → false stale dist | `tools/verify-guards.mjs` utimes |
| F6 | pin replace dropped intermittent kinds | pin UNION + `last_turn_summary` |
| F7 | DETECT false-positive concurrent real sessions | `tools/isolated-test.mjs` scratch-cwd filter |

Register: `docs/bug-sweep/FINDINGS.md` — open REPRODUCED: **0**.

## Spec checklist

`docs/bug-sweep/GOAL-SPEC-2026-08-13.md` — S0–S6 complete when this report is written.

## Process notes

- Hooks installed: agent-os commit-msg + pre-commit.
- Official test order preserved: suite → build → real (package.json).
- Standing debt (not gate failures): 2 eslint `any` warnings; 2 win32-only unprovable guards; mock-backed test debt under directive 03 (directive-check notes, not violations).

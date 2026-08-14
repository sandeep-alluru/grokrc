# Findings register · grokrc bug sweep · 2026-08-13

Evidence classes per agent-os 07. Only **open REPRODUCED** blocks done.

| ID | One-line | Verdict | Gate | Status |
|----|----------|---------|------|--------|
| F1 | eslint: useless `httpOk` init + unused `readableToolBody` → lint exit 1 | REPRODUCED | G2 | **closed** |
| F2 | prettier: 19 files drift → format:check exit 1 | REPRODUCED | G3 | **closed** |
| F3 | acp pin: live method `_x.ai/mcp/tools_changed` unknown → test:real exit 1 | REPRODUCED | G6 | **closed** |
| F4 | G6 first attempt: stale dist vs src (harness correctly refused) | not a defect | G6 | closed |
| F5 | suite / guard restore bumps src mtime → real-stack "dist older than src" | REPRODUCED | G6/G7 | **closed** |
| F6 | pin replace dropped intermittent `last_turn_summary` → conformance flaky | REPRODUCED | G6 | **closed** |
| F7 | isolated-test DETECT false-positive on concurrent real jarhead sessions | REPRODUCED | G6 | **closed** |

Open REPRODUCED count: **0**

---

### F1 · lint errors in web/app.js — CLOSED

- **Verdict:** REPRODUCED  
- **Evidence (PRE-FIX):** `npm run lint` EXIT:1 — 3 errors in `web/app.js` (no-useless-assignment @255, no-unused-vars @1139)  
- **REANALYSE:** `upsertTool` is one-line only and drops `<pre>` bodies. `readableToolBody` had zero call sites (repo grep). Dead code after UI decision, not a live wrong render.  
- **POST-FIX:** remove dead helper; init `httpOk` only from fetch/catch. `npm run lint` EXIT:0 (2 warnings remain on `any` — not errors).  
- **ISOLATED:** lint fails when unused `readableToolBody` is reintroduced (no-unused-vars is the load-bearing detector for that half).  
- **Radius:** phone client only; no wire format change.  
- **Fix:** `web/app.js`

### F2 · format drift — CLOSED

- **Verdict:** REPRODUCED  
- **PRE-FIX:** `npm run format:check` EXIT:1, 19 files  
- **POST-FIX:** `npm run format` then format:check EXIT:0  
- **ISOLATED:** style gate itself (prettier --check)  
- **Radius:** source formatting only  

### F3 · ACP surface pin drift — CLOSED

- **Verdict:** REPRODUCED  
- **PRE-FIX:** acp-conformance PROBLEM `methods=[_x.ai/mcp/tools_changed]` on grok 1.0.3; `test:real` EXIT:1  
- **REANALYSE:** claimed shapes still present (tool_call, permissions, turn_completed). New MCP method is surface expansion; pin was stale for 1.0.0.  
- **POST-FIX:** `npm run pin:acp` → fixture agent 1.0.3 + methods include `_x.ai/mcp/tools_changed`; `npm run test:real` EXIT:0, four ALL CLEAR  
- **ISOLATED:** acp-conformance unknown-method check (disabling pin membership of new method re-fails)  
- **Radius:** real-stack gate + mock accountability; no runtime product path change except measured fixture  
- **Fix:** `test/fixtures/acp-surface.json` via `tools/acp-conformance.mjs --pin`

### F4 · stale dist — not a defect

Harness assertBuildIsFresh working as designed (BACKLOG #21).

### F5 · guard restore bumps mtime — CLOSED

- **Verdict:** REPRODUCED  
- **PRE-FIX:** `npm run build` then `npm run test:suite` → `src/daemon/events.ts` mtime advances (writeFile restore in `tools/verify-guards.mjs` via `test/verify-guards.test.ts`); delta src−dist ≈ +70s; next `test:real` throws dist older than src. RUN-2 G6 EXIT:1 and G7 baseline FAIL cascade measured in `docs/bug-sweep/runs/RUN-2/`.  
- **Candidates:** product code drift · harness wrong · suite poison mtime · RUN order wrong  
- **REANALYSE:** package.json order is `test:suite && build && test:real` — intentional rebuild after suite. Suite still poisons anyone who builds first. Measured: only `events.ts` mtime changed among src tops.  
- **POST-FIX:** restore writes content then `utimes` original atime/mtime. After `test/verify-guards.test.ts`, events mtime identical; delta src−dist negative.  
- **ISOLATED:** utimes after writeFile is load-bearing — writeFile alone re-bumps mtime (PRE-FIX measurement).  
- **Radius:** all guards that mutate src; real-stack checks after suite without rebuild.  
- **Fix:** `tools/verify-guards.mjs`  


### F6 · pin replace drops intermittent kinds — CLOSED
- **Verdict:** REPRODUCED
- **PRE-FIX:** RUN-3 G6: kinds=[last_turn_summary] unknown after prior pin removed it (model-dependent)
- **POST-FIX:** pin is UNION across runs; fixture includes last_turn_summary from measured RUN-3 observation
- **ISOLATED:** replace-not-union was load-bearing failure mode
- **Fix:** tools/acp-conformance.mjs --pin + fixture

### F7 · concurrent real sessions trip DETECT — CLOSED
- **Verdict:** REPRODUCED (detector wrong for concurrent non-scratch cwd)
- **PRE-FIX:** new jarhead session during suite → isolated-test exit 1
- **POST-FIX:** only scratch cwds (tmpdir / test markers) count as leaks
- **ISOLATED:** isScratchCwd filter
- **Fix:** tools/isolated-test.mjs

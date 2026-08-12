# Contributing to grokrc

Thanks for looking. This document covers how to get the project running, what the bar
is for a change, and the few conventions that are non-negotiable.

---

## Contents

1. [Getting set up](#1-getting-set-up)
2. [Running the tests](#2-running-the-tests)
3. [The bar for a bug fix](#3-the-bar-for-a-bug-fix)
4. [Code conventions](#4-code-conventions)
5. [Commit messages](#5-commit-messages)
6. [Pull requests](#6-pull-requests)
7. [Project layout](#7-project-layout)
8. [Good first issues](#8-good-first-issues)

---

## 1. Getting set up

**Requirements**

- **Node 20+** (developed on 22.x). `--experimental-strip-types` is used to run
  TypeScript tests directly, so older Node will not work.
- **[Grok Build](https://github.com/xai-org/grok-build)** on your `PATH` — developed
  against `0.2.118` and `1.0.0`. Needed only for the real-stack tests; unit and browser tests run
  without it.
- **Chromium**, installed via Playwright.

```bash
git clone https://github.com/sandeep-alluru/grokrc.git
cd grokrc
npm ci
npx playwright install --with-deps chromium

npm run build
npm test
```

Run the daemon from source without building:

```bash
npm run dev -- up --pair --cwd ~/code
```

Confirm your Grok install speaks ACP at all:

```bash
npm run probe          # tools/acp-probe.mjs — raw ACP handshake
node --experimental-strip-types src/cli.ts doctor
```

---

## 2. Running the tests

**Real tests only (directive 03).** A product claim is proven by a real run of
the real stack — real `grok`, real daemon, real browser, real filesystem. Mocks
and scripted transports may exist for speed, but they are **debt** and must
never be cited as proof that production works. The default `npm test` ends in
`test:real`, which is the gate that counts.

```bash
npm test                 # suite → build → real-stack checks (the bar)
npm run test:suite       # node:test files (includes mock-backed UI tests — not product proof)
npm run test:real        # REAL grok + real PWA: live-ui, resume, midturn, acp-conformance
npm run check:approval   # REAL remote approval path (e2e-drive) — must see session/request_permission
npm run check:stranger   # REAL first-run install into a sandboxed home
npm run check:live       # REAL browser against the daemon that is already running
npm run typecheck
npm run lint
npm run format:check
```

**`--test-concurrency=1` is deliberate.** Several test files launch Chromium; running
them in parallel made the suite flaky. Do not remove it to speed things up.

**The suite runs under a scratch `GROK_HOME`** (`tools/isolated-test.mjs`), because a
real `grok` records every session it runs and keeps it forever. Your own `~/.grok` is
counted before and after; if the suite writes there, the run fails and names what
leaked. If a test genuinely needs to read your real history, read it explicitly —
`test/observer.test.ts` does — and never write to it.

Tests that need the `grok` binary **skip themselves, loudly**, when it is absent — they
print which check did not run rather than passing quietly. A silent skip is
indistinguishable from a pass, which is how a guard here once certified a control that
did not exist. If you are changing ACP behaviour, run the real-stack checks locally —
CI cannot cover you there.

### Test layout

| File                          | Covers                                          |
| ----------------------------- | ----------------------------------------------- |
| `test/*.test.ts`              | unit + browser tests (Playwright against the real PWA) |
| `tools/live-ui-check.mjs`     | a full turn against real Grok, asserted in a real browser |
| `tools/resume-check.mjs`      | close a session, resume it, prove memory survived |
| `tools/live-check.mjs`        | drives the **running** daemon in a real browser (`npm run check:live`) |
| `tools/*-probe.mjs`           | manual protocol probes, not part of `npm test`  |

`npm test` boots its own daemon in-process, so it cannot see whether the daemon you
are actually serving has been restarted, or whether a phone is running a cached
bundle. Both have happened. `npm run check:live` pairs itself through the control
socket and walks the real flows against the live daemon; run it after deploying.

---

## 3. The bar for a bug fix

This is the part that actually matters, and it is stricter than most projects.

### Spec first — [docs/BUG-SPEC.md](docs/BUG-SPEC.md)

**If you can reproduce a bug, you must write it into `docs/BUG-SPEC.md` and fix
only against that checklist.** No code-first fixes. No “document later.”

For every defect (or “I think this is broken”):

1. **Reproduce** (or attach owner evidence: log path, capture). If you cannot
   reproduce and have no evidence, do not ship a “bug fix” — hardening only.
2. **Add a row** (`B#`) to the **index** in `docs/BUG-SPEC.md` **before coding**.
3. **Pre-fix** — numbered reproduce steps, expected vs actual, evidence,
   **Done when** (one observable sentence).
4. **Real-bug?** — product · upstream agent · by design · not a bug. If by design
   / not a bug: document and stop.
5. **Implement** only that ID, in **execution order** (do not skip ahead).
6. **Post-fix** — re-run the same path or a named test; residual; evidence class
   (VERIFIED / PARTIAL / UNVERIFIED / BLOCKED). Update index + execution log.
7. **Local browser before phone** — for any UI or phone-path bug, prove the fix
   with Playwright/Chromium against a local daemon first (see
   `test/handback-e2e.test.ts`, `test/browser.test.ts`). **Do not ask the owner
   to re-test on their phone until that local browser proof is green.**

Windows measurement gaps still live in [docs/WINDOWS-GAPS.md](docs/WINDOWS-GAPS.md);
product defects from live use go in **BUG-SPEC**. Historical ledger:
[docs/BACKLOG.md](docs/BACKLOG.md).

**A bug found by reading code is a hypothesis, not a bug.** Before you claim something
is broken:

1. **Reproduce it.** Write a test that fails against current `main` (and log it under
   Pre-fix in BUG-SPEC).
2. **Show the transition.** The test must fail before your fix and pass after. A test
   that passes both ways proves nothing — it may exercise nothing.
3. **Isolate the control.** If your fix changes more than one thing, disable the part
   you believe is load-bearing and confirm the test fails again. Otherwise you do not
   know which change did the work.

   Then **register it** in `tools/guards.mjs` so the proof re-runs:

   ```js
   { id: 'takeover-pid-identity',
     why: 'pids get recycled; without the argv[0] check a phone tap kills something else',
     file: 'src/daemon/session-manager.ts',
     find: '    if (!looksLikeGrok(args)) {',
     replace: '    if (false && !looksLikeGrok(args)) {',
     test: 'test/takeover.test.ts' }
   ```

   ```bash
   npm run guards          # list what is registered
   npm run verify:guards   # disable each control; its test MUST fail
   ```

   CI runs this as its own job. Nine such proofs previously lived only in commit
   messages, which do not re-run.
4. **Look for the twin.** Nearly every defect in this codebase has had a second copy on
   a parallel path — `create()` missing a check that `resume()` had, and so on. Find it
   before you open the PR.
5. **Run the full suite.** A local fix that breaks something else is not a fix.

If you cannot reproduce it, that is fine — label the PR **hardening** rather than a bug
fix, and say what you could not observe.

> Seven times during this project, a test measured the wrong thing and reported success
> or failure incorrectly. When a result surprises you, suspect the test first.

### Writing a regression test

Open with a comment explaining the **failure**, not the code:

```ts
/**
 * iOS exposes `PushManager` ONLY in a home-screen app — in a Safari tab it is
 * absent. `renderPushPrompt()` guarded on that and returned early, so on the one
 * platform where push needs an extra step the UI showed no row and no reason.
 *
 * Written before the fix. PRE-FIX this fails on the first assert.
 */
```

Wait for the thing you actually assert on. Waiting for event A and asserting on
event B is the single most common flake in this repo.

---

## 4. Code conventions

- **TypeScript, ESM, no build step for the web client.** `web/` is served as-is; there
  is no bundler and no framework. Keep it that way.
- **No duplicated implementations.** One code path parameterized by its input beats two
  paths that drift. Scale means more items through one pipeline.
- **Comments explain _why_.** The codebase is dense with reasoning about protocol
  quirks and platform behaviour. Match that. Do not narrate what the line does.
- **Never fail silently.** An early `return` that leaves the user with no explanation is
  treated as a defect here, not a style choice. Return a reason; surface it.
- **`.session` means a session.** Class names are selectors that tests and users both
  depend on. Do not reuse a class for something it does not describe.

Formatting and linting are enforced in CI:

```bash
npm run format
npm run lint:fix
```

---

## 5. Commit messages

Short imperative subject, then the reasoning. For anything claiming a fix, include the
evidence:

```
Fix push prompt vanishing on iOS Safari tabs

renderPushPrompt() returned early when PushManager was absent, so a Safari tab
showed no row and no reason. The row now always renders and names the fix.

PRE-FIX:  ✗ no push row rendered (test/push-prompt.test.ts)
POST-FIX: ✓ 2/2 pass
ISOLATED: restoring the guard fails the test again
```

---

## 6. Pull requests

- Branch from `main`.
- One logical change per PR.
- Fill in the PR template — especially the reproduction section.
- CI must be green: typecheck, lint, format, build, tests.
- New behaviour needs a test. New user-facing behaviour needs a docs update.

Not every PR will be merged. If you are planning something large, open an issue first
so we can agree on the approach before you spend the time.

---

## 7. Project layout

```
src/
  acp/            ACP client, NDJSON transport, mock transport
  daemon/         session manager, server, auth, push, observer, config, preflight
  relay/          self-hostable relay server
  term/           terminal client that talks to the grokrc daemon
  cli.ts          command-line entry point
web/              the PWA — served as-is, no build step
test/             unit + browser tests
tools/            real-stack checks and protocol probes
packaging/systemd user service
docs/             setup, user guide, architecture, research
```

Start with [`docs/01-architecture.md`](docs/01-architecture.md) — it explains why the
daemon owns sessions and how observed mode reads Grok's own logs.

---

## 8. Good first issues

- **More control-socket commands.** `grokrc doctor` still spawns its own probe session
  rather than asking the running daemon for its state, and `config set` still needs a
  restart to apply. The channel exists (`src/daemon/control.ts`); the commands do not.
- **Android home-screen install guidance.** The docs are iOS-heavy because that is where
  push is hardest.
- **Test files still using `MockTransport` where a real-stack check would be stronger** —
  7 of 20 today.

---

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE), and to abide by the
[Code of Conduct](CODE_OF_CONDUCT.md).

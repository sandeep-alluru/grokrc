## What this changes

<!-- One or two sentences. What is different after this PR? -->

## Why

<!-- The problem being solved. Link the issue if there is one: Fixes #123 -->

## Evidence

<!--
For a BUG FIX, this section is required. A bug found by reading code is a
hypothesis; show that you made it fail on demand and then stop failing.

  PRE-FIX:  ✗ <test name> — <the failure message>
  POST-FIX: ✓ <test name>
  ISOLATED: <reverting the load-bearing change makes it fail again>

If you could not reproduce it, say so and label this hardening instead.
-->

```
PRE-FIX:
POST-FIX:
ISOLATED:
```

## The twin

<!--
Nearly every defect in this codebase has had a second copy on a parallel path
(create/resume, owned/observed, daemon/relay). Where did you look, and what did
you find?
-->

## Checklist

- [ ] `npm test` passes locally (full suite, not just `test:mock`)
- [ ] `npm run typecheck && npm run lint && npm run format:check` pass
- [ ] New behaviour has a test
- [ ] User-facing changes are documented (`README.md` / `docs/`)
- [ ] `CHANGELOG.md` updated under `## [Unreleased]`
- [ ] No secrets, tokens, or personal paths in the diff

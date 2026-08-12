# Contributing

## Setup

```bash
git clone https://github.com/sandeep-alluru/grokrc.git
cd grokrc
npm install
npm run build
```

Requires Node 20+. Optional: Grok Build on `PATH` for real-stack tests.

## Commands

```bash
npm test              # unit/browser suite + build + real-stack checks
npm run test:suite    # mock/unit/browser only
npm run test:real     # live UI / resume / midturn / ACP surface (needs grok)
npm run typecheck
npm run lint
npm run verify:guards # each load-bearing control must fail its test when disabled
```

Real-stack tools skip cleanly when `grok` is missing so CI stays green without the agent.

## Layout

```
src/          product code
web/          PWA
test/         tests
tools/        probes, backlog, guards, real-stack harness
docs/         GUIDE.md + ARCHITECTURE.md (+ internal BACKLOG.md)
packaging/    systemd / Windows installers
```

Start with [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Pull requests

1. Keep changes focused.  
2. Add or update tests for behaviour changes.  
3. Do not hardcode test counts in user docs.  
4. Run `npm test` (and `verify:guards` for control changes) before asking for review.

## Code of conduct

[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

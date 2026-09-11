# TOOLCHAIN-RECEIPT

- status: PASS
- skill version: 1.0.0
- UTC start: 2026-09-11T00:00:43Z
- UTC end: 2026-09-11T00:01:28Z
- real root: `/home/clawer-samurai-1/AgentHub/grokrc`
- lexical root: `/home/clawer-samurai-1/AgentHub/grokrc`
- helper hashes: `{"hook_helper.py": "929c7071dd7cc8237da0356e75d89eb4e3edb287a40ee3ab0630f1399d77dc57", "setup.py": "b781790958e6f3343f0ec4e3932a9663646423c6854be6ea0fd959488f9b9231", "toolchain_lib.py": "cf95d78294af4c8addedd032367dfed7e573d60310169cbb218024ad6a4b3b51"}`
- languages detected: ['javascript', 'shell', 'typescript']
- unsupported: ['shell']
- configs: `{"ruff": null, "pyproject": null, "pyright": null, "eslint": "/home/clawer-samurai-1/AgentHub/grokrc/eslint.config.js", "prettier": "/home/clawer-samurai-1/AgentHub/grokrc/.prettierrc.json", "tsconfigs": ["/home/clawer-samurai-1/AgentHub/grokrc/tsconfig.json", "/home/clawer-samurai-1/AgentHub/grokrc/glasses/tsconfig.json"]}`
- suites: `[{"kind": "npm", "classification": "suite", "cwd": "/home/clawer-samurai-1/AgentHub/grokrc", "argv": ["npm", "run", "test:unit"], "shell": false, "evidence": "package.json scripts.test:unit override; scripts.test='npm run test:suite && npm run build && npm run test:real' includes live test:real; scripts.test:unit='node --test --experimental-strip-types test/events.test.ts test/observer.test.ts test/preflight.test.ts test/push.test.ts test/relay.test.ts test/server.test.ts'"}]`
- unresolved suite candidates: `[]`
- pruned: `[{"path": ".git", "reason": "excluded directory .git"}, {"path": "node_modules", "reason": "excluded directory node_modules"}, {"path": "dist", "reason": "excluded directory dist"}, {"path": "glasses/node_modules", "reason": "excluded directory node_modules"}, {"path": "glasses/dist", "reason": "excluded directory dist"}]`
- writes: `["/home/clawer-samurai-1/AgentHub/grokrc/.claude/settings.json", "/home/clawer-samurai-1/AgentHub/grokrc/.claude/rules/testing.md", "/home/clawer-samurai-1/AgentHub/grokrc/.claude/rules/security.md"]`
- notes: ['negative gates ran on job-home fixture; original source not mutated; original suites NOT RUN']
- merge_status: created

## G2 Stop-hook amendments

- Stop bound to `npm run test:unit`, not `npm test` (VERDICT.md ESCALATED C-STOP-LIVE). See suites above and package.json scripts.test / scripts.test:unit.

## Tool versions (measured)

```
{
  "ruff": "ruff 0.16.7",
  "pyright": "pyright 1.1.414",
  "pytest": "pytest 9.1.1",
  "eslint": "v9.39.1",
  "prettier": "3.9.6",
  "tsc": "Version 5.9.3",
  "vitest": "vitest/5.0.0 linux-x64 node-v22.22.2",
  "gitleaks": "gitleaks version 8.30.1"
}
```


# Testing

Toolchain Stop runs this project's detected suites only if the current session edited a code file (the PostToolUse helper writes a session marker). No marker means no suite. A detected-none project keeps the marker and does not invent a runner.

Detected suites:

- npm (suite): cwd=/home/clawer-samurai-1/AgentHub/grokrc argv=['npm', 'run', 'test:unit']


Unresolved candidates are not treated as detected-none.

Negative controls that must block: a remaining lint error, a gitleaks finding on the edited file, a type error on git commit/push, and a red suite. Missing runners, collection failures, and timeouts are failures, not green.

Do not mass-format or mass-lint the repository. Hooks act on the edited file only.

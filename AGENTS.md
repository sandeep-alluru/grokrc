<!-- BEGIN command-center-identity v1 — managed by ~/AgentHub/2ndbrain/ops/onboard_projects.py; edit that script, not this block -->
## This project in the Command Center

Tenant `t.grokrc` — projects are ids of the form `p.grokrc.<project>`. **Read the contract before you
create anything here:** `~/AgentHub/2ndbrain/ops/PROJECT-ONBOARDING.md`.

- launch an agent run:  `~/AgentHub/2ndbrain/ops/run.sh <tenant> <goal> <task> -- <command>`
- launch a service:     `~/AgentHub/2ndbrain/ops/runjob.sh <tenant> <project> <unit> -- <command>`
  (it stamps TENANT_ID/PROJECT_ID/SESSION_ID into the unit, so every process the service spawns is
  attributable; a unit started any other way has no session and cannot be reconstructed)
- a new workstream:     declare it in `~/AgentHub/2ndbrain/ops/projects.json` with a claim and its
  evidence. Undeclared work is counted, never guessed — it lands in `p.grokrc.adhoc-project`.
- see it live:          http://127.0.0.1:3100/2nd-brain/command-center (CEO Office → 2nd Brain)

Do not invent ids, do not infer a project from a thin signal, and do not start a service outside
`runjob.sh`.
<!-- END command-center-identity -->

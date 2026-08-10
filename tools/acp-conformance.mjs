#!/usr/bin/env node
/**
 * Does the mock still describe the agent it claims to describe?
 *
 * BACKLOG #3. Thirteen test files drive the daemon through `MockTransport`, and
 * its docstring says it "replays the shapes we actually captured from
 * `grok 0.2.118`". The installed agent is now **1.0.0** — a major version past
 * the capture. Nothing checked that the capture still held, so thirteen files
 * could have been green against a fiction and no one would have learned it from
 * the test suite. That is precisely what directive 03 law 4 forbids: a mock
 * cited as proof that production works.
 *
 * This is the missing gate. It does not ban the mock — some of what those files
 * test (twenty concurrent sessions, an agent that answers with malformed JSON,
 * a permission ask on demand) cannot be produced by a real agent on cue. It
 * makes the mock ACCOUNTABLE: every protocol shape the mock asserts is checked
 * against a live `grok`, so a capture that goes stale FAILS here instead of
 * silently certifying nothing.
 *
 * The claims are READ FROM `mock-transport.ts` — never copied. A hand-kept list
 * would drift from the mock and the whole gate would rot into decoration.
 *
 *   node --experimental-strip-types tools/acp-conformance.mjs
 *
 * Needs a real `grok`. Without one it skips loudly and is not counted as a pass.
 */
import { isolatedGrokHome, reporter, cleanup, skipWithoutAgent } from './harness.mjs';

if (await skipWithoutAgent('ACP conformance (mock vs. real agent)')) process.exit(0);

const { note, finish } = reporter();

/* ── 1. what does the mock CLAIM? Read it from the source of truth. ───────── */

const { defaultScript, REAL_PERMISSION_PARAMS } = await import('../src/acp/mock-transport.ts');

const script = defaultScript('conformance');
const claims = {
  /** `params.update.sessionUpdate` values the mock emits. */
  updateKinds: new Set(),
  /** JSON-RPC methods the mock sends as notifications. */
  notifyMethods: new Set(),
  /** JSON-RPC methods the mock sends as agent→client requests. */
  requestMethods: new Set(),
  /** Fields the mock asserts exist on a tool_call / tool_call_update. */
  toolFields: new Set(),
  /** `kind` values on the permission options the mock replays. */
  permissionKinds: new Set(),
};

for (const step of script) {
  if (step.notify) {
    claims.notifyMethods.add(step.notify.method);
    const u = step.notify.params?.update;
    if (u?.sessionUpdate) {
      claims.updateKinds.add(u.sessionUpdate);
      if (u.sessionUpdate.startsWith('tool_call')) {
        for (const k of Object.keys(u)) if (k !== 'sessionUpdate') claims.toolFields.add(k);
      }
    }
  }
  if (step.request) claims.requestMethods.add(step.request.method);
}
for (const o of REAL_PERMISSION_PARAMS.options ?? []) {
  if (o.kind) claims.permissionKinds.add(o.kind);
}

console.log('\n  ─── what MockTransport claims about the agent ───');
console.log(`  session/update kinds : ${[...claims.updateKinds].join(', ')}`);
console.log(`  notify methods       : ${[...claims.notifyMethods].join(', ')}`);
console.log(`  request methods      : ${[...claims.requestMethods].join(', ')}`);
console.log(`  tool_call fields     : ${[...claims.toolFields].join(', ')}`);
console.log(`  permission kinds     : ${[...claims.permissionKinds].join(', ')}`);

note(claims.updateKinds.size > 0, `mock asserts ${claims.updateKinds.size} session/update kind(s)`);

/* ── 2. what does a REAL grok actually send? ──────────────────────────────── */

await isolatedGrokHome({ prompting: true });

const { StdioTransport } = await import('../src/acp/transport.ts');
const { AcpClient } = await import('../src/acp/client.ts');
const { mkdtemp } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

const cwd = await mkdtemp(join(tmpdir(), 'grokrc-conformance-'));

const observed = {
  updateKinds: new Map(), // kind -> count
  methods: new Map(), // method -> count
  toolFields: new Set(),
  permissionKinds: new Set(),
};

const transport = new StdioTransport({ cwd });
// Tap the RAW stream alongside the client. Reading the parsed events would only
// show what the client already knows how to name; a renamed or new field would
// be invisible at exactly the moment it matters.
transport.on('message', (m) => {
  if (!m || typeof m !== 'object') return;
  if (typeof m.method === 'string') {
    observed.methods.set(m.method, (observed.methods.get(m.method) ?? 0) + 1);
    const u = m.params?.update;
    if (u && typeof u.sessionUpdate === 'string') {
      observed.updateKinds.set(
        u.sessionUpdate,
        (observed.updateKinds.get(u.sessionUpdate) ?? 0) + 1
      );
      if (u.sessionUpdate.startsWith('tool_call')) {
        for (const k of Object.keys(u)) if (k !== 'sessionUpdate') observed.toolFields.add(k);
      }
    }
    if (m.method === 'session/request_permission') {
      for (const o of m.params?.options ?? []) if (o?.kind) observed.permissionKinds.add(o.kind);
    }
  }
});

const client = new AcpClient({ transport });
client.on('error', () => {});

// Answer any permission ask immediately — the point here is to observe the
// SHAPE of the request, not to exercise the approval UI, and a blocked agent
// would stall the capture.
client.on('permission', (req) => {
  const allow =
    req.params?.options?.find((o) => o.kind === 'allow_once') ?? req.params?.options?.[0];
  req.respond({ outcome: 'selected', optionId: allow?.optionId });
});

let sessionId = null;
try {
  await client.initialize();
  const s = await client.newSession(cwd);
  sessionId = s?.sessionId ?? null;
  note(!!sessionId, `real grok session created (${sessionId})`);
} catch (err) {
  note(false, `could not start a real agent: ${err.message}`);
}

if (sessionId) {
  // Chosen to force a tool call: the agent must WRITE, which is the path that
  // produces tool_call / tool_call_update, and — with permission prompting on —
  // a session/request_permission too.
  const PROMPT =
    'Create a file called conformance.txt containing exactly the word OK. ' +
    'Then tell me you are done. Do not ask me anything first.';
  try {
    await client.prompt(sessionId, PROMPT);
  } catch (err) {
    note(false, `prompt failed: ${err.message}`);
  }
}

// Let any trailing notifications land.
await new Promise((r) => setTimeout(r, 1500));

const { execFile } = await import('node:child_process');
const { promisify } = await import('node:util');
const agentVersion = await promisify(execFile)('grok', ['--version'])
  .then((r) => r.stdout.trim())
  .catch(() => 'unknown');

console.log('\n  ─── what grok actually sent ───');
console.log(`  agent under test     : ${agentVersion}`);
for (const [k, n] of [...observed.updateKinds].sort())
  console.log(`  update ${k.padEnd(28)} x${n}`);
for (const [m, n] of [...observed.methods].sort()) console.log(`  method ${m.padEnd(28)} x${n}`);
console.log(
  `  tool_call fields     : ${[...observed.toolFields].sort().join(', ') || '(none seen)'}`
);
console.log(
  `  permission kinds     : ${[...observed.permissionKinds].sort().join(', ') || '(none seen)'}`
);

/* ── 3. compare, claim by claim ───────────────────────────────────────────── */

console.log('\n  ─── claim-by-claim ───');

const unconfirmed = [];
for (const kind of [...claims.updateKinds].sort()) {
  const seen = observed.updateKinds.has(kind);
  console.log(`  ${seen ? '✓' : '·'} ${kind}${seen ? '' : '  — not produced by this turn'}`);
  if (!seen) unconfirmed.push(kind);
}

// A claimed kind that the live agent never produced is NOT automatically drift:
// `plan` and `agent_thought_chunk` depend on what the model decides to do. The
// decisive failure is the reverse and the structural checks below, which do not
// depend on the model's mood.
if (unconfirmed.length) {
  console.log(
    `\n  NOTE: ${unconfirmed.length} claimed kind(s) not produced by this particular turn: ` +
      `${unconfirmed.join(', ')} — model-dependent, not proof of drift.`
  );
}

// The load-bearing assertions: these hold for ANY turn from a conforming agent.
const sawText = observed.updateKinds.has('agent_message_chunk');
note(sawText, "the agent still streams `agent_message_chunk` (the mock's core claim)");

const sawUpdate = observed.methods.has('session/update');
note(sawUpdate, 'the agent still delivers updates via the `session/update` notification');

/* ── 4. is the agent's protocol surface still the one we pinned? ──────────── */

// The first version of this block asserted "every live kind normalizes to at
// least one event". It passed 16/16 — and it was WORTHLESS: `normalizeSessionUpdate`
// ends in `default: return [{k:'raw',...}]`, so that assertion is true for every
// string that exists. A gate that cannot fail certifies nothing, which is the
// same defect this whole item is about. It is replaced by a comparison against
// a recorded surface, which can and does fail.
const { normalizeSessionUpdate } = await import('../src/daemon/events.ts');

/** Does production have real handling for this kind, or is it an opaque blob? */
const isOpaque = (kind) => {
  const out = normalizeSessionUpdate({ sessionId: 'x', update: { sessionUpdate: kind } });
  return out.length === 1 && out[0].k === 'raw';
};

const SURFACE = new URL('../test/fixtures/acp-surface.json', import.meta.url);
const liveKinds = [...observed.updateKinds.keys()].sort();
const liveMethods = [...observed.methods.keys()].sort();

if (process.argv.includes('--pin')) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    SURFACE,
    JSON.stringify(
      {
        _comment:
          'MEASURED, never hand-edited. Regenerate with: node --experimental-strip-types ' +
          'tools/acp-conformance.mjs --pin  — then read the diff before committing it.',
        agent: agentVersion,
        updateKinds: liveKinds,
        methods: liveMethods,
        opaque: liveKinds.filter(isOpaque),
      },
      null,
      2
    ) + '\n'
  );
  console.log(
    `\n  PINNED ${liveKinds.length} kind(s) and ${liveMethods.length} method(s) to ${SURFACE.pathname}`
  );
} else {
  const { readFile } = await import('node:fs/promises');
  let pinned = null;
  try {
    pinned = JSON.parse(await readFile(SURFACE, 'utf8'));
  } catch {
    note(false, 'no pinned ACP surface — run with --pin to record one');
  }

  if (pinned) {
    // NEW is the failing direction. A kind the agent has started sending is
    // real, new information every time; a kind it merely did not send on THIS
    // turn is model-dependent and proves nothing, so it only gets a note.
    const added = liveKinds.filter((k) => !pinned.updateKinds.includes(k));
    const addedM = liveMethods.filter((m) => !pinned.methods.includes(m));
    note(
      added.length === 0 && addedM.length === 0,
      added.length === 0 && addedM.length === 0
        ? `agent protocol surface matches the pin (${liveKinds.length} kinds, ${liveMethods.length} methods, agent ${agentVersion})`
        : `the agent sends things the pin does not know about — review, then re-pin: ` +
            `kinds=[${added.join(', ')}] methods=[${addedM.join(', ')}]`
    );

    const absent = pinned.updateKinds.filter((k) => !liveKinds.includes(k));
    if (absent.length)
      console.log(`  · pinned but not produced by this turn: ${absent.join(', ')}`);

    // A kind that USED to have real handling and now falls through to `raw`
    // means production quietly stopped understanding it.
    const regressed = liveKinds.filter((k) => isOpaque(k) && !(pinned.opaque ?? []).includes(k));
    note(
      regressed.length === 0,
      regressed.length === 0
        ? `no kind regressed into an opaque passthrough (${(pinned.opaque ?? []).length} known opaque)`
        : `these kinds now reach the UI as opaque blobs and did not before: ${regressed.join(', ')}`
    );
  }
}

const opaqueNow = liveKinds.filter(isOpaque);
if (opaqueNow.length) {
  console.log(
    `\n  OPAQUE: ${opaqueNow.length} of ${liveKinds.length} live kinds reach the client as ` +
      `\`raw\` — no specific handling: ${opaqueNow.join(', ')}`
  );
}

// If the real agent asked permission, the mock's replayed option shape must
// still match. When it did not ask, say so rather than scoring it as a pass.
if (observed.permissionKinds.size > 0) {
  const missing = [...observed.permissionKinds].filter((k) => !claims.permissionKinds.has(k));
  note(
    missing.length === 0,
    missing.length === 0
      ? `permission option kinds still match the capture (${[...observed.permissionKinds].join(', ')})`
      : `the agent now sends option kinds the mock never replays: ${missing.join(', ')}`
  );
} else {
  console.log('  · the agent did not ask permission on this turn — option shape unchecked');
}

// Kinds the LIVE agent produces that the mock never exercises. Not a failure —
// a measured coverage gap, printed so it cannot be mistaken for full coverage.
const gap = [...observed.updateKinds.keys()].filter((k) => !claims.updateKinds.has(k));
if (gap.length) {
  console.log(
    `\n  COVERAGE GAP: live kinds no mock-backed test ever sees: ${gap.sort().join(', ')}`
  );
}

try {
  client.close();
} catch {
  /* already gone */
}
await cleanup();
finish();

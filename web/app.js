/**
 * grokrc phone client.
 *
 * No framework, no build step — it is served straight off the daemon. The whole
 * point is that it renders *typed* agent events (tool calls, plans, permission
 * requests) as real UI, rather than painting a terminal into a canvas.
 */

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'grokrc.token';
const RELAY_KEY = 'grokrc.relay';

/**
 * Relay awareness.
 *
 * Served directly by the daemon, everything is same-origin and these are null.
 * Served by a relay, the page URL carries ?room=&key= — which must be attached
 * to the WebSocket path and to every /api call so the relay knows which daemon
 * to tunnel to. Persisted because a PWA launched from the home screen opens at
 * "/" with no query string.
 */
const relay = (() => {
  const q = new URLSearchParams(location.search);
  const room = q.get('room');
  const key = q.get('key');
  // The encryption secret arrives in the FRAGMENT, which browsers never send to
  // the server — so the relay can route this connection without being able to
  // read it. See web/crypto.js.
  const secret = new URLSearchParams(location.hash.slice(1)).get('e');
  if (room && key) {
    const cfg = { room, key, secret };
    localStorage.setItem(RELAY_KEY, JSON.stringify(cfg));
    // Strip the secret from the address bar so it doesn't sit in screenshots,
    // shared links, or session restore.
    history.replaceState(null, '', location.pathname + location.search);
    return cfg;
  }
  try {
    return JSON.parse(localStorage.getItem(RELAY_KEY) || 'null');
  } catch {
    return null;
  }
})();

/** Same-origin path, plus the room when we're behind a relay. */
const api = (path) => (relay ? `${path}?room=${encodeURIComponent(relay.room)}` : path);

/* ─── end-to-end encryption (relay mode only) ────────────────────────────── */

let cryptoKey = null;
let cryptoMod = null;

async function initCrypto() {
  if (!relay?.secret) return null;
  if (cryptoKey) return cryptoKey;
  cryptoMod = await import('/crypto.js');
  cryptoKey = await cryptoMod.deriveKey(relay.secret);
  return cryptoKey;
}

/** Encrypt for the wire when relayed; pass through when talking to the daemon directly. */
async function sealIfRelayed(plaintext) {
  const key = await initCrypto();
  if (!key) return plaintext;
  return JSON.stringify(await cryptoMod.seal(key, plaintext));
}

async function openIfRelayed(wire) {
  const key = await initCrypto();
  if (!key) return wire;
  let parsed;
  try {
    parsed = JSON.parse(wire);
  } catch {
    return wire;
  }
  if (!cryptoMod.isEnvelope(parsed)) return wire;
  return cryptoMod.open(key, parsed);
}

/** POST JSON through the relay with the body encrypted end-to-end. */
async function apiPost(path, bodyObj) {
  const raw = JSON.stringify(bodyObj);
  const res = await fetch(api(path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: await sealIfRelayed(raw),
  });
  const text = await res.text();
  let payload;
  try {
    payload = JSON.parse(await openIfRelayed(text));
  } catch {
    payload = {};
  }
  return { ok: res.ok, status: res.status, body: payload };
}

const el = {
  conn: $('conn'),
  title: $('title'),
  back: $('back'),
  vPair: $('v-pair'),
  vList: $('v-list'),
  vSession: $('v-session'),
  code: $('code'),
  pairGo: $('pair-go'),
  pairErr: $('pair-err'),
  composer: $('composer'),
  input: $('input'),
  send: $('send'),
};

const state = {
  token: localStorage.getItem(TOKEN_KEY),
  ws: null,
  sessions: [],
  current: null,
  /** toolId -> DOM node, so tool_call_update mutates in place */
  toolNodes: new Map(),
  /** requestId -> DOM node */
  approvalNodes: new Map(),
  /** streaming agent bubble currently being appended to */
  streaming: null,
  /** current thinking block being appended to (thinking streams token-by-token) */
  thinkingNode: null,
  planNode: null,
  busy: false,
  backoff: 500,
  /** Daemon shares one `grok agent leader` backend — set from the ready frame. */
  leaderMode: false,
  /** The Resume button awaiting a reply, so a refusal can restore it. */
  pendingResume: null,
};

/* ─── views ──────────────────────────────────────────────────────────────── */

function show(view) {
  for (const v of [el.vPair, el.vList, el.vSession]) v.classList.remove('on');
  view.classList.add('on');
  const inSession = view === el.vSession;
  el.composer.hidden = !inSession;
  el.back.hidden = !inSession;
}

function setConn(cls) {
  el.conn.className = 'dot' + (cls ? ' ' + cls : '');
}

/* ─── pairing ────────────────────────────────────────────────────────────── */

el.pairGo.addEventListener('click', async () => {
  const code = el.code.value.trim().toUpperCase();
  if (code.length < 4) return (el.pairErr.textContent = 'Enter the 6-character code.');
  el.pairGo.disabled = true;
  el.pairErr.textContent = '';
  try {
    const { ok, body } = await apiPost('/api/pair', {
      code,
      deviceName: navigator.userAgent.slice(0, 60),
    });
    if (!ok) throw new Error(body.error || 'pairing failed');
    state.token = body.token;
    localStorage.setItem(TOKEN_KEY, body.token);
    connect();
    void setupPush();
  } catch (err) {
    el.pairErr.textContent = err.message;
  } finally {
    el.pairGo.disabled = false;
  }
});

el.code.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el.pairGo.click();
});

/* ─── socket ─────────────────────────────────────────────────────────────── */

function connect() {
  if (!state.token) return show(el.vPair);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // Behind a relay the socket must name its room; direct to the daemon it's
  // just the origin.
  const path = relay
    ? `/client?room=${encodeURIComponent(relay.room)}&key=${encodeURIComponent(relay.key)}`
    : '';
  const ws = new WebSocket(`${proto}://${location.host}${path}`);
  state.ws = ws;
  // Test hook: browser tests need to simulate a network drop, and there is no
  // other way to reach a module-scoped socket from page.evaluate().
  globalThis.__rcws = ws;

  ws.addEventListener('open', () => {
    state.backoff = 500;
    setConn('live');
    sendMsg({ t: 'hello', token: state.token });
  });

  // Frames arrive sealed in relay mode. Serialize decryption so events cannot
  // reorder — a tool_call_update overtaking its tool_call would corrupt the UI.
  let inbound = Promise.resolve();
  ws.addEventListener('message', (e) => {
    inbound = inbound.then(async () => {
      let msg;
      try {
        msg = JSON.parse(await openIfRelayed(e.data));
      } catch {
        return;
      }
      handle(msg);
    });
  });

  ws.addEventListener('close', (e) => {
    setConn('err');
    if (e.code === 4401) {
      // Token rejected — drop it and go back to pairing rather than reconnect-looping.
      localStorage.removeItem(TOKEN_KEY);
      state.token = null;
      return show(el.vPair);
    }
    setTimeout(connect, state.backoff);
    state.backoff = Math.min(state.backoff * 2, 15000);
  });

  ws.addEventListener('error', () => setConn('err'));
}

// Outbound frames are sealed in relay mode. Chained for the same ordering
// reason as inbound — an approval answer must not overtake the prompt.
let outbound = Promise.resolve();

/**
 * Send, or say why not.
 *
 * This used to `return` silently when the socket wasn't open, so a prompt typed
 * during a reconnect vanished with no feedback at all — the same failure mode as
 * the swallowed prompt rejection in the daemon. Anything the user *typed* is now
 * queued and flushed on reconnect; bookkeeping frames are dropped, because
 * replaying a stale `sessions` request after reconnect is noise.
 */
const outboundQueue = [];
const QUEUEABLE = new Set(['prompt', 'approve']);

function sendMsg(payload) {
  const raw = JSON.stringify(payload);
  outbound = outbound.then(async () => {
    if (state.ws?.readyState !== 1) {
      if (QUEUEABLE.has(payload.t)) {
        outboundQueue.push(payload);
        appendError('Not connected — will send when the connection returns.');
      }
      return;
    }
    state.ws.send(await sealIfRelayed(raw));
  });
}

/** Replay anything the user typed while the socket was down. */
function flushOutbound() {
  if (!outboundQueue.length) return;
  const pending = outboundQueue.splice(0);
  appendError(`Reconnected — sending ${pending.length} queued message(s).`);
  for (const p of pending) sendMsg(p);
}

function handle(msg) {
  switch (msg.t) {
    case 'ready':
      state.leaderMode = !!msg.leaderMode;
      // On a RECONNECT the user is usually mid-session. Unconditionally showing
      // the list threw them out of the transcript they were reading — often
      // mid-turn, with no explanation. Reopen what they had instead.
      if (state.current) {
        show(el.vSession);
        sendMsg({ t: 'open', sessionId: state.current.id, cwd: state.current.cwd });
      } else {
        show(el.vList);
      }
      sendMsg({ t: 'sessions' });
      flushOutbound();
      break;
    case 'sessions':
      state.sessions = msg.sessions;
      renderList();
      break;
    case 'created':
      openSession(msg.session);
      break;
    case 'resumed':
      // Now live: drop the resume bar, reveal the composer, keep the transcript.
      state.pendingResume = null;
      state.current = msg.session;
      el.title.textContent = msg.session.title;
      el.composer.hidden = false;
      el.vSession.querySelector('[data-resume]')?.remove();
      break;
    case 'history':
      renderTranscript(msg.events);
      break;
    case 'event':
      if (!state.current || msg.event.sessionId !== state.current.id) {
        // Not the open session — refresh the list so a pending approval elsewhere shows up.
        if (msg.event.k === 'approval') sendMsg({ t: 'sessions' });
        return;
      }
      applyEvent(msg.event);
      break;
    case 'error':
      appendError(msg.message);
      // Restore a Resume button left mid-flight, or it reads 'Resuming…' forever
      // with no way to retry.
      if (state.pendingResume) {
        state.pendingResume.disabled = false;
        state.pendingResume.textContent = state.current?.externallyActive
          ? 'Take control'
          : 'Resume session';
        state.pendingResume = null;
      }
      break;
  }
}

/* ─── session list ───────────────────────────────────────────────────────── */

function renderList() {
  // The list re-renders whenever the daemon broadcasts a change — including
  // while you're inside a session. Only claim the header if the list is what's
  // actually on screen, or opening a session immediately relabels it "Sessions".
  if (!state.current) el.title.textContent = 'Sessions';
  el.vList.replaceChildren();

  const newBtn = document.createElement('button');
  newBtn.className = 'btn-primary';
  newBtn.textContent = '+ New session';
  newBtn.style.marginBottom = '14px';
  newBtn.addEventListener('click', () => sendMsg({ t: 'create' }));
  el.vList.append(newBtn);

  // iOS only honours a permission request inside a user gesture, so this row
  // exists to BE that gesture. It also reports why push is off, instead of the
  // app silently never subscribing.
  renderPushPrompt();

  if (!state.sessions.length) {
    const p = document.createElement('div');
    p.className = 'empty';
    p.textContent = 'No sessions yet.';
    el.vList.append(p);
    return;
  }

  for (const s of state.sessions) {
    const row = document.createElement('div');
    row.className = 'session';

    const dot = document.createElement('span');
    dot.className =
      'dot' +
      (s.pendingApprovals ? ' wait' : s.externallyActive || s.mode !== 'observed' ? ' live' : '');

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = s.title;
    const sub = document.createElement('div');
    sub.className = 'sub';
    // Most of this list is history on disk. Say plainly which rows you can
    // actually talk to, or every past session looks like a live one.
    sub.textContent = s.externallyActive
      ? `live in terminal · ${s.cwd}`
      : s.mode === 'observed'
        ? `past session · ${s.cwd}`
        : `${s.mode} · ${s.cwd}`;
    meta.append(name, sub);

    row.append(dot, meta);

    if (s.pendingApprovals) {
      const b = document.createElement('span');
      b.className = 'badge';
      b.textContent = s.pendingApprovals + ' waiting';
      row.append(b);
    } else {
      const t = document.createElement('span');
      t.className = 'tag';
      t.textContent = s.mode === 'observed' ? 'read-only' : s.state;
      row.append(t);
    }

    row.addEventListener('click', () => openSession(s));
    el.vList.append(row);
  }
}

el.back.addEventListener('click', () => {
  // Tell the daemon to stop tailing so observers don't accumulate.
  if (state.current?.mode === 'observed') {
    sendMsg({ t: 'close', sessionId: state.current.id });
  }
  state.current = null;
  sendMsg({ t: 'sessions' });
  show(el.vList);
});

function openSession(s) {
  state.current = s;
  state.toolNodes.clear();
  state.approvalNodes.clear();
  state.streaming = null;
  state.planNode = null;
  el.title.textContent = s.title;
  el.vSession.replaceChildren();
  show(el.vSession);
  // Observed sessions are read-only — there is no way to inject a prompt into a
  // session we don't own, so don't offer a composer that would silently fail.
  el.composer.hidden = s.mode === 'observed';
  el.title.textContent = s.mode === 'observed' ? `${s.title} (read-only)` : s.title;
  if (s.mode === 'observed') renderResumeBar(s);
  renderPlaceholder();
  // cwd lets the daemon locate the on-disk log for a session it doesn't own.
  sendMsg({ t: 'open', sessionId: s.id, cwd: s.cwd });
}

/* ─── transcript ─────────────────────────────────────────────────────────── */

/** Mirrors INTERRUPTS_STREAM in the daemon — see session-manager.ts. */
const INTERRUPTS = new Set(['tool', 'plan', 'approval', 'error', 'text']);

/**
 * An empty session must not look like a broken one. Also carries the read-only
 * notice for observed sessions — it lives here rather than in openSession
 * because history replaces the transcript wholesale and would otherwise wipe it.
 */
function renderPlaceholder() {
  const d = document.createElement('div');
  d.className = 'empty';
  d.dataset.placeholder = '1';
  d.textContent =
    state.current?.mode === 'observed'
      ? 'Watching a session started elsewhere — read-only.'
      : 'No messages yet. Send one below to start.';
  el.vSession.append(d);
}

/**
 * A past session is read-only only until you ask for it back. Grok can reopen
 * it (`session/load`), so offer that rather than leaving a dead transcript with
 * no way to continue — which is exactly what a session you started yourself
 * looked like once its process ended.
 */
function renderResumeBar(s) {
  const bar = document.createElement('div');
  bar.className = 'resume-bar';
  bar.dataset.resume = '1';

  const label = document.createElement('div');
  label.className = 'sub';

  // A session another process owns can only be JOINED when a shared leader is
  // running — otherwise taking it would put a second, independent agent on the
  // same conversation. Without a leader, watching is the only safe action.
  // `joinable` is the daemon's verdict on the OWNING process — a session can be
  // live elsewhere and still not joinable (anything started before leader mode
  // was on). Trust that flag, not merely "is something else running".
  if (s.externallyActive && !(s.joinable && state.leaderMode)) {
    label.textContent =
      '● Live in a terminal that is not sharing a backend — mirroring it here, read-only. ' +
      'Restart that session with a shared leader to drive it from your phone.';
    bar.append(label);
    el.vSession.prepend(bar);
    return;
  }

  label.textContent = s.externallyActive
    ? '● Live in your terminal, on a shared backend — you can drive it from here too.'
    : 'Read-only. Reopen it to keep going.';

  const btn = document.createElement('button');
  btn.className = 'btn-primary';
  btn.textContent = s.externallyActive ? 'Take control' : 'Resume session';
  btn.addEventListener('click', () => {
    btn.disabled = true;
    btn.textContent = 'Resuming…';
    // Resume can legitimately fail — the daemon refuses a session live in a
    // standalone process, and refuses once MAX_LIVE_SESSIONS is reached. Without
    // a recovery path the button would read "Resuming…" forever with no retry,
    // which is the same dead-end the terminal client had on a refused resume.
    state.pendingResume = btn;
    sendMsg({ t: 'resume', sessionId: s.id, cwd: s.cwd });
  });

  bar.append(label, btn);
  el.vSession.prepend(bar);
}

function renderTranscript(events) {
  el.vSession.replaceChildren();
  state.toolNodes.clear();
  state.approvalNodes.clear();
  state.streaming = null;
  state.planNode = null;
  // HARDENING, not a fix: replaceChildren() detaches every node, so a retained
  // thinkingNode would receive appends nobody can see. Today that never bites,
  // because history replay always contains a `text` event and applyEvent clears
  // it as an INTERRUPTS kind — verified by test/client-state.ts, which passes
  // against the code without this line. Relying on that incidental clear is the
  // fragility; a replay of only thinking chunks would break it.
  state.thinkingNode = null;
  for (const ev of events) applyEvent(ev, true);
  if (!events.length) renderPlaceholder();
  // History replaces the transcript wholesale, so the resume affordance has to
  // be re-added here or it vanishes the moment the log arrives.
  if (state.current?.mode === 'observed') renderResumeBar(state.current);
  scrollDown();
}

/** Drop the placeholder as soon as there is anything real to show. */
function clearPlaceholder() {
  if (state.current?.mode === 'observed') return; // the read-only notice stays
  el.vSession.querySelector('[data-placeholder]')?.remove();
}

function applyEvent(ev, replaying = false) {
  if (ev.k !== 'status' && ev.k !== 'commands') clearPlaceholder();
  // Only genuinely interrupting content ends a thinking run. Metadata events
  // (status, commands, mode, raw) interleave constantly and must not split it.
  if (INTERRUPTS.has(ev.k)) state.thinkingNode = null;
  switch (ev.k) {
    case 'text': {
      if (ev.role === 'user') {
        state.streaming = null;
        appendBubble('user', ev.text);
      } else if (ev.final) {
        // Whole message: replace whatever we streamed, so replay isn't doubled.
        if (state.streaming) {
          state.streaming.textContent = ev.text;
          state.streaming = null;
        } else appendBubble('agent', ev.text);
      } else {
        if (!state.streaming) state.streaming = appendBubble('agent', '');
        state.streaming.textContent += ev.text;
      }
      break;
    }

    case 'thinking': {
      // Thinking streams token-by-token. A new node per chunk turned every
      // single word into its own bordered block — accumulate into one instead.
      if (!state.thinkingNode) {
        state.thinkingNode = document.createElement('div');
        state.thinkingNode.className = 'thinking';
        el.vSession.append(state.thinkingNode);
      }
      // `final` carries the whole coalesced block — REPLACE what we streamed,
      // don't append, or the reasoning renders twice.
      if (ev.final) state.thinkingNode.textContent = ev.text;
      else state.thinkingNode.textContent += ev.text;
      break;
    }

    case 'tool':
      upsertTool(ev);
      break;
    case 'plan':
      upsertPlan(ev);
      break;
    case 'approval':
      upsertApproval(ev);
      break;

    case 'approval-resolved': {
      const node = state.approvalNodes.get(ev.requestId);
      if (node) {
        node.classList.add('resolved');
        node.querySelectorAll('button').forEach((b) => (b.disabled = true));
      }
      break;
    }

    case 'status':
      state.busy = ev.state === 'working' || ev.state === 'thinking';
      el.send.textContent = state.busy ? 'Stop' : 'Send';
      el.send.classList.toggle('stop', state.busy);
      setConn(ev.state === 'awaiting-approval' ? 'wait' : 'live');
      if (ev.state !== 'working' && ev.state !== 'thinking') state.streaming = null;
      break;

    case 'error':
      appendError(ev.message);
      break;
  }
  if (!replaying) scrollDown();
}

function appendBubble(role, text) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + role;
  const b = document.createElement('div');
  b.className = 'bubble';
  b.textContent = text;
  wrap.append(b);
  el.vSession.append(wrap);
  return b;
}

function appendError(message) {
  const d = document.createElement('div');
  d.className = 'err-line';
  d.textContent = message;
  el.vSession.append(d);
  scrollDown();
}

function upsertTool(ev) {
  let node = state.toolNodes.get(ev.toolId);
  if (!node) {
    node = document.createElement('div');
    node.innerHTML = '<div class="hd"><span class="nm"></span><span class="st"></span></div>';
    state.toolNodes.set(ev.toolId, node);
    el.vSession.append(node);
  }
  node.className = 'tool ' + ev.status;
  node.querySelector('.nm').textContent = ev.title || ev.name;
  node.querySelector('.st').textContent = ev.status;

  const body = ev.output ?? ev.input;
  if (body !== undefined && body !== null) {
    let pre = node.querySelector('pre');
    if (!pre) {
      pre = document.createElement('pre');
      node.append(pre);
    }
    pre.textContent = readableToolBody(body);
  }
}

/**
 * Grok's tool results wrap the useful text in structure — a Bash result carries
 * `output` as an array of BYTE VALUES plus a human-readable `output_for_prompt`.
 * Dumping the raw object showed a wall of numbers, so prefer whichever field is
 * actually meant to be read.
 */
function readableToolBody(body) {
  if (typeof body === 'string') return body;
  if (body && typeof body === 'object') {
    for (const key of ['output_for_prompt', 'output_text', 'stdout', 'content', 'text']) {
      if (typeof body[key] === 'string' && body[key].trim()) return body[key];
    }
    // Byte arrays are noise; drop them and show the rest.
    const trimmed = {};
    for (const [k, v] of Object.entries(body)) {
      const isByteArray =
        Array.isArray(v) &&
        v.length > 4 &&
        v.every((n) => typeof n === 'number' && n >= 0 && n < 256);
      if (!isByteArray) trimmed[k] = v;
    }
    return JSON.stringify(trimmed, null, 2);
  }
  return String(body);
}

function upsertPlan(ev) {
  if (!state.planNode) {
    state.planNode = document.createElement('div');
    state.planNode.className = 'plan';
    el.vSession.append(state.planNode);
  }
  const ul = document.createElement('ul');
  for (const it of ev.items) {
    const li = document.createElement('li');
    const done = /complete|done/i.test(it.status);
    li.className = done ? 'done' : '';
    li.textContent = (done ? '✓ ' : '○ ') + it.text;
    ul.append(li);
  }
  state.planNode.replaceChildren(ul);
}

function upsertApproval(ev) {
  if (state.approvalNodes.has(ev.requestId)) return;

  const box = document.createElement('div');
  box.className = 'approval';

  const h = document.createElement('h3');
  h.textContent = ev.title;
  box.append(h);

  if (ev.toolName) {
    const why = document.createElement('div');
    why.className = 'why';
    why.textContent =
      ev.toolName +
      (ev.locations?.length ? ' · ' + ev.locations.map((l) => l.path).join(', ') : '');
    box.append(why);
  }

  if (ev.input !== undefined && ev.input !== null) {
    const pre = document.createElement('pre');
    pre.textContent = typeof ev.input === 'string' ? ev.input : JSON.stringify(ev.input, null, 2);
    box.append(pre);
  }

  const row = document.createElement('div');
  row.className = 'row';

  // Grok lists the BROADEST grant first — a real request came back as
  // ["allow all edits this session", "Yes", "No"]. Rendering that order puts
  // the widest permission under the user's thumb. Narrow grants come first
  // here, and "always" is visually demoted so it can't be tapped by reflex.
  const rank = (o) =>
    o.intent === 'allow' && o.kind === 'allow_once'
      ? 0
      : o.intent === 'allow'
        ? 1
        : o.intent === 'deny'
          ? 2
          : 3;
  const options = [...ev.options].sort((a, b) => rank(a) - rank(b));

  for (const opt of options) {
    const b = document.createElement('button');
    const broad = opt.kind === 'allow_always';
    b.className = opt.intent + (broad ? ' broad' : '');
    b.textContent = opt.label;
    if (broad) b.title = 'Grants permission for the rest of this session';
    b.addEventListener('click', () => {
      row.querySelectorAll('button').forEach((x) => (x.disabled = true));
      sendMsg({
        t: 'approve',
        sessionId: ev.sessionId,
        requestId: ev.requestId,
        optionId: opt.id,
      });
    });
    row.append(b);
  }
  box.append(row);

  state.approvalNodes.set(ev.requestId, box);
  el.vSession.append(box);
  scrollDown();

  // Buzz — this is the moment the whole product exists for.
  navigator.vibrate?.([40, 60, 40]);
}

function scrollDown() {
  requestAnimationFrame(() => {
    const m = document.querySelector('main');
    m.scrollTop = m.scrollHeight;
  });
}

/* ─── composer ───────────────────────────────────────────────────────────── */

el.input.addEventListener('input', () => {
  el.input.style.height = 'auto';
  el.input.style.height = Math.min(el.input.scrollHeight, 120) + 'px';
});

el.send.addEventListener('click', () => {
  if (!state.current) return;
  if (state.busy) return sendMsg({ t: 'cancel', sessionId: state.current.id });
  const text = el.input.value.trim();
  if (!text) return;
  sendMsg({ t: 'prompt', sessionId: state.current.id, text });
  el.input.value = '';
  el.input.style.height = 'auto';
});

/* ─── push notifications ─────────────────────────────────────────────────── */

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

/**
 * Register for push.
 *
 * `fromGesture` matters on iOS: `Notification.requestPermission()` is only
 * honoured inside a user gesture. Called during page load it is silently
 * ignored — no prompt, no error, permission stays "default" — so the app
 * connects normally and simply never subscribes. That is exactly what happened
 * on the owner's iPhone: paired, PWA running, zero subscriptions.
 *
 * On boot we therefore only re-subscribe if permission was ALREADY granted.
 * Asking is deferred to a button the user taps.
 *
 * Returns a short status string so the UI can say what happened instead of
 * failing invisibly.
 */
async function setupPush({ fromGesture = false } = {}) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return 'unsupported: this browser has no service worker or push support';
  }
  if (!state.token) return 'not paired yet';
  if (!globalThis.isSecureContext) {
    return 'needs HTTPS — push cannot work over plain http';
  }
  if (Notification.permission === 'denied') {
    return 'blocked in system settings — enable notifications for this app, then retry';
  }
  if (Notification.permission === 'default' && !fromGesture) {
    // Asking here would be swallowed on iOS. Let the user tap instead.
    return 'needs-permission';
  }

  try {
    const reg = await navigator.serviceWorker.register('/sw.js');

    const { publicKey } = await (await fetch(api('/api/push/key'))).json();
    if (!publicKey) return 'daemon has push disabled (--no-push)';

    // Only reached from a gesture, or when permission was already granted.
    if (Notification.permission === 'default') {
      const res = await Notification.requestPermission();
      if (res !== 'granted') return `permission ${res}`;
    }
    if (Notification.permission !== 'granted') return `permission ${Notification.permission}`;

    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      }));

    // Carries a device token — must be sealed like pairing is.
    const { ok, body } = await apiPost('/api/push/subscribe', {
      token: state.token,
      subscription: sub,
    });
    if (!ok) return `daemon refused the subscription: ${body.error ?? 'unknown'}`;
    return 'ok';
  } catch (err) {
    // Push is an enhancement; the app must work without it. But it must not fail
    // INVISIBLY — an unexplained absence of notifications is unfixable by a user.
    console.warn('push unavailable:', err.message);
    return `failed: ${err.message}`;
  }
}

/**
 * A tappable row that both explains the state and satisfies iOS's gesture
 * requirement. Shown in the session list whenever push is not yet active.
 */
function renderPushPrompt() {
  // Push already works — nothing to say.
  if (pushPermission() === 'granted') return;

  const blocker = pushBlocker();

  const row = document.createElement('div');
  row.className = 'notice';
  row.dataset.pushPrompt = '1';

  const meta = document.createElement('div');
  meta.className = 'meta';
  const name = document.createElement('div');
  name.className = 'name';
  const sub = document.createElement('div');
  sub.className = 'sub';

  if (blocker) {
    // The platform cannot do push from here. Say so and name the way out —
    // an early `return` would leave the user hunting for a button that the
    // code decided not to draw.
    name.textContent = '🔔 Notifications are off';
    sub.textContent = blocker;
    row.style.opacity = '0.75';
  } else {
    name.textContent = '🔔 Enable notifications';
    sub.textContent =
      pushPermission() === 'denied'
        ? 'Blocked — allow notifications for this app in system settings, then tap'
        : 'Get told when a turn finishes or the agent needs approval';
  }
  meta.append(name, sub);
  row.append(meta);

  // Tapping is what satisfies iOS's gesture requirement. Kept live even when
  // blocked, so a user who just fixed system settings can retry in place.
  row.addEventListener('click', async () => {
    sub.textContent = 'requesting…';
    const status = await setupPush({ fromGesture: true });
    if (status === 'ok') {
      name.textContent = '🔔 Notifications enabled';
      sub.textContent = 'You will be notified when a turn finishes.';
      setTimeout(() => row.remove(), 2500);
    } else {
      sub.textContent = status;
    }
  });

  el.vList.append(row);
}

/** `Notification.permission`, or null where the API does not exist (iOS Safari tab). */
function pushPermission() {
  return typeof Notification === 'undefined' ? null : Notification.permission;
}

/** True when running as an installed app rather than a browser tab. */
function isStandalone() {
  return (
    globalThis.matchMedia?.('(display-mode: standalone)').matches === true ||
    navigator.standalone === true
  );
}

/**
 * Why push cannot be turned on from this page, or null when it can.
 *
 * The interesting case is iOS: `PushManager` exists ONLY in a home-screen app,
 * so a Safari tab is not broken — it is the wrong container, and saying which
 * one to use is the entire fix.
 */
function pushBlocker() {
  if (!globalThis.isSecureContext) return 'Needs HTTPS — open this page over https.';
  if (!('serviceWorker' in navigator)) return 'This browser has no service worker support.';
  if (!('PushManager' in window)) {
    return isStandalone()
      ? 'This browser does not support push notifications.'
      : 'Tap Share → Add to Home Screen, then open grokrc from that icon — iOS only allows notifications there.';
  }
  return null;
}

// Tapping a notification focuses an existing tab — jump it to the right session.
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type !== 'open-session' || !e.data.sessionId) return;
  const target = state.sessions.find((s) => s.id === e.data.sessionId);
  if (target) openSession(target);
  else sendMsg({ t: 'sessions' });
});

/* ─── boot ───────────────────────────────────────────────────────────────── */

if (state.token) {
  connect();
  // No gesture here — on iOS an unprompted request is swallowed. This only
  // re-subscribes when permission was granted previously.
  void setupPush();
} else {
  show(el.vPair);
}

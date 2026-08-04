/**
 * grokrc phone client.
 *
 * No framework, no build step — it is served straight off the daemon. The whole
 * point is that it renders *typed* agent events (tool calls, plans, permission
 * requests) as real UI, rather than painting a terminal into a canvas.
 */

const $ = (id) => document.getElementById(id);
const TOKEN_KEY = 'grokrc.token';

const el = {
  conn: $('conn'), title: $('title'), back: $('back'),
  vPair: $('v-pair'), vList: $('v-list'), vSession: $('v-session'),
  code: $('code'), pairGo: $('pair-go'), pairErr: $('pair-err'),
  composer: $('composer'), input: $('input'), send: $('send'),
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
  planNode: null,
  busy: false,
  backoff: 500,
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
    const res = await fetch('/api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, deviceName: navigator.userAgent.slice(0, 60) }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'pairing failed');
    state.token = body.token;
    localStorage.setItem(TOKEN_KEY, body.token);
    connect();
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
  const ws = new WebSocket(`${proto}://${location.host}`);
  state.ws = ws;

  ws.addEventListener('open', () => {
    state.backoff = 500;
    setConn('live');
    ws.send(JSON.stringify({ t: 'hello', token: state.token }));
  });

  ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handle(msg);
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

function sendMsg(payload) {
  if (state.ws?.readyState === 1) state.ws.send(JSON.stringify(payload));
}

function handle(msg) {
  switch (msg.t) {
    case 'ready':
      show(el.vList);
      sendMsg({ t: 'sessions' });
      break;
    case 'sessions':
      state.sessions = msg.sessions;
      renderList();
      break;
    case 'created':
      openSession(msg.session);
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
      break;
  }
}

/* ─── session list ───────────────────────────────────────────────────────── */

function renderList() {
  el.title.textContent = 'Sessions';
  el.vList.replaceChildren();

  const newBtn = document.createElement('button');
  newBtn.className = 'btn-primary';
  newBtn.textContent = '+ New session';
  newBtn.style.marginBottom = '14px';
  newBtn.addEventListener('click', () => sendMsg({ t: 'create' }));
  el.vList.append(newBtn);

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
    dot.className = 'dot' + (s.pendingApprovals ? ' wait' : s.mode === 'observed' ? '' : ' live');

    const meta = document.createElement('div');
    meta.className = 'meta';
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = s.title;
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = `${s.mode} · ${s.cwd}`;
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
      t.textContent = s.state;
      row.append(t);
    }

    row.addEventListener('click', () => openSession(s));
    el.vList.append(row);
  }
}

el.back.addEventListener('click', () => {
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
  sendMsg({ t: 'open', sessionId: s.id });
}

/* ─── transcript ─────────────────────────────────────────────────────────── */

function renderTranscript(events) {
  el.vSession.replaceChildren();
  state.toolNodes.clear();
  state.approvalNodes.clear();
  state.streaming = null;
  state.planNode = null;
  for (const ev of events) applyEvent(ev, true);
  scrollDown();
}

function applyEvent(ev, replaying = false) {
  switch (ev.k) {
    case 'text': {
      if (ev.role === 'user') {
        state.streaming = null;
        appendBubble('user', ev.text);
      } else if (ev.final) {
        // Whole message: replace whatever we streamed, so replay isn't doubled.
        if (state.streaming) { state.streaming.textContent = ev.text; state.streaming = null; }
        else appendBubble('agent', ev.text);
      } else {
        if (!state.streaming) state.streaming = appendBubble('agent', '');
        state.streaming.textContent += ev.text;
      }
      break;
    }

    case 'thinking': {
      const d = document.createElement('div');
      d.className = 'thinking';
      d.textContent = ev.text;
      el.vSession.append(d);
      break;
    }

    case 'tool': upsertTool(ev); break;
    case 'plan': upsertPlan(ev); break;
    case 'approval': upsertApproval(ev); break;

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

    case 'error': appendError(ev.message); break;
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
    node.innerHTML =
      '<div class="hd"><span class="nm"></span><span class="st"></span></div>';
    state.toolNodes.set(ev.toolId, node);
    el.vSession.append(node);
  }
  node.className = 'tool ' + ev.status;
  node.querySelector('.nm').textContent = ev.title || ev.name;
  node.querySelector('.st').textContent = ev.status;

  const body = ev.output ?? ev.input;
  if (body !== undefined && body !== null) {
    let pre = node.querySelector('pre');
    if (!pre) { pre = document.createElement('pre'); node.append(pre); }
    pre.textContent = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
  }
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
    why.textContent = ev.toolName + (ev.locations?.length ? ' · ' + ev.locations.map(l => l.path).join(', ') : '');
    box.append(why);
  }

  if (ev.input !== undefined && ev.input !== null) {
    const pre = document.createElement('pre');
    pre.textContent = typeof ev.input === 'string' ? ev.input : JSON.stringify(ev.input, null, 2);
    box.append(pre);
  }

  const row = document.createElement('div');
  row.className = 'row';
  for (const opt of ev.options) {
    const b = document.createElement('button');
    b.className = opt.intent;
    b.textContent = opt.label;
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

/* ─── boot ───────────────────────────────────────────────────────────────── */

if (state.token) connect();
else show(el.vPair);

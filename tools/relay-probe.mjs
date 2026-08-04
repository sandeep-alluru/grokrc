#!/usr/bin/env node
/**
 * Relay wire-format probe.
 *
 * `grok agent headless --grok-ws-url <URL>` is real but undocumented — it shows
 * up in `--help` with an empty description. This stands up a throwaway
 * WebSocket server, points the agent at it, and records exactly what the agent
 * does: the HTTP upgrade path, headers, subprotocol, and every frame.
 *
 *   node tools/relay-probe.mjs [--seconds 20]
 *
 * Output: docs/captures/relay-probe.json
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'docs/captures');
const argv = process.argv.slice(2);
const secIdx = argv.indexOf('--seconds');
const SECONDS = secIdx !== -1 ? Number(argv[secIdx + 1]) : 20;

const record = { upgrades: [], frames: [], stderr: '', stdout: '', exit: null };

const http = createServer((req, res) => {
  // Log any plain HTTP the agent tries first (discovery, health, auth).
  record.upgrades.push({ kind: 'http', method: req.method, url: req.url, headers: req.headers });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{}');
});

const wss = new WebSocketServer({ server: http });

wss.on('headers', (headers, req) => {
  record.upgrades.push({
    kind: 'upgrade',
    url: req.url,
    headers: req.headers,
    responseHeaders: headers,
  });
});

wss.on('connection', (ws, req) => {
  console.log(`  ✓ agent connected: ${req.url}`);
  console.log(`    protocol: ${ws.protocol || '(none)'}`);

  // The agent connects and then says nothing, so the protocol is
  // client-speaks-first: the relay must drive it with ordinary ACP. Prove that
  // by sending a real handshake and seeing whether it answers.
  const send = (obj) => {
    const text = JSON.stringify(obj);
    record.frames.push({ dir: 'relay->agent', t: Date.now(), text });
    console.log(`  -> ${text.slice(0, 160)}`);
    ws.send(text + '\n');
  };
  setTimeout(
    () =>
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 1,
          clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        },
      }),
    600
  );
  setTimeout(
    () =>
      send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: ROOT, mcpServers: [] } }),
    2500
  );

  ws.on('message', (data, isBinary) => {
    const text = isBinary ? `<binary ${data.length}b>` : data.toString();
    record.frames.push({ dir: 'agent->relay', t: Date.now(), text });
    console.log(`  <- ${text.slice(0, 240)}`);
  });
  ws.on('close', (code, reason) => {
    record.frames.push({ dir: 'close', code, reason: reason?.toString() });
    console.log(`  × closed ${code} ${reason}`);
  });
  ws.on('error', (e) => console.log(`  ! ws error: ${e.message}`));
});

await new Promise((res) => http.listen(0, '127.0.0.1', res));
const port = http.address().port;
const url = `ws://127.0.0.1:${port}/relay`;
console.log(`relay listening ${url}\nlaunching agent…\n`);

const child = spawn('grok', ['agent', 'headless', '--grok-ws-url', url, '--debug'], {
  cwd: ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', (c) => (record.stdout += c.toString()));
child.stderr.on('data', (c) => {
  const s = c.toString();
  record.stderr += s;
  process.stdout.write('  [stderr] ' + s.split('\n')[0] + '\n');
});
child.on('exit', (code) => {
  record.exit = code;
  console.log(`  agent exited: ${code}`);
});

await new Promise((res) => setTimeout(res, SECONDS * 1000));
child.kill();
wss.close();
http.close();

mkdirSync(OUT, { recursive: true });
const file = resolve(OUT, 'relay-probe.json');
writeFileSync(file, JSON.stringify(record, null, 2));
console.log(
  `\nupgrades: ${record.upgrades.length}  frames: ${record.frames.length}  exit: ${record.exit}`
);
console.log(`-> ${file}`);
process.exit(0);

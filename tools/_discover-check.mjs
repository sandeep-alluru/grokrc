import { SessionManager } from './src/daemon/session-manager.ts';
const sm = new SessionManager();
const list = await sm.discoverOnDisk(10);
console.log('count', list.length);
for (const s of list) {
  console.log(
    [s.externallyActive ? 'LIVE' : 'past', s.id.slice(0, 13), s.title, s.cwd].join(' | ')
  );
}

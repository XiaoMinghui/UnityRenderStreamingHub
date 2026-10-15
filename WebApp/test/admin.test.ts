/** @jest-environment node */
import { createServer, Server } from 'http';
import WebSocket = require('ws');
import WSSignaling from '../src/websocket';
import { createServer as createApp } from '../src/server';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
describe('authenticated instance pool management', () => {
  let server: Server, signaling: WSSignaling, base: string;
  const sockets: WebSocket[] = [];
  async function boot(enabled = true) {
    const app = createApp({ type: 'websocket', mode: 'public', logging: 'none', pool: true,
      poolToken: 'sender-secret', admin: enabled, adminToken: 'admin-secret' });
    server = createServer(app);
    signaling = new WSSignaling(server, 'public', 20000, 3, { senderToken: 'sender-secret' });
    app.locals.pool = signaling.pool;
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  }
  afterEach(async () => {
    sockets.splice(0).forEach(s => s.terminate()); signaling?.close();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  });
  function api(path = '/state', method = 'GET', token = 'admin-secret', origin?: string) {
    return fetch(base + '/admin/api' + path, { method,
      headers: { Authorization: `Bearer ${token}`, ...(origin ? { Origin: origin } : {}) } });
  }
  async function client(message: object) {
    const socket = new WebSocket(base.replace('http:', 'ws:') + '/pool'); sockets.push(socket);
    const messages: any[] = []; socket.on('message', data => messages.push(JSON.parse(String(data))));
    await new Promise<void>(resolve => socket.once('open', resolve));
    socket.send(JSON.stringify(message));
    async function next(type: string) {
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        const index = messages.findIndex(m => m.type === type);
        if (index >= 0) return messages.splice(index, 1)[0];
        await delay(5);
      }
      throw new Error('Missing ' + type);
    }
    return { socket, next };
  }
  async function sender() {
    const s = await client({ type: 'register', instanceId: 'sender-1', poolId: 'default', token: 'sender-secret' });
    const reset = await s.next('reset'); s.socket.send(JSON.stringify({ type: 'ready', resetId: reset.resetId }));
    await s.next('ready'); return s;
  }
  test('disabled by default; credentials required, isolated from sender secret and hidden from config/snapshots', async () => {
    expect(() => createApp({ admin: true })).toThrow(/separate/);
    expect(() => createApp({ admin: true, pool: true, poolToken: 'same', adminToken: 'same' })).toThrow(/separate/);
    await boot(false); expect((await api()).status).toBe(404);
  });
  test('auth, same-origin mutation guard, no-store and safe snapshots', async () => {
    await boot(); await sender();
    expect((await api('/state', 'GET', '')).status).toBe(401);
    expect((await api('/state', 'GET', 'sender-secret')).status).toBe(401);
    expect((await api('/instances/sender-1/drain', 'POST', 'admin-secret', 'https://other.example')).status).toBe(403);
    const response = await api(); expect(response.headers.get('cache-control')).toBe('no-store');
    const state = await response.json() as any;
    expect(state.summary).toMatchObject({ online: 1, idle: 1 });
    const text = JSON.stringify(state) + JSON.stringify(await (await fetch(base + '/config')).json());
    for (const secret of ['admin-secret', 'sender-secret', 'resetId', 'leaseId', 'socket']) expect(text).not.toContain(secret);
    expect((await api('/instances/sender-1/invalid', 'POST')).status).toBe(400);
    expect((await api('/instances/missing/drain', 'POST')).status).toBe(404);
  });
  test('drain preserves active session; resume allocates FIFO; administrative end resets without exposing tickets', async () => {
    await boot(); const s = await sender();
    const r = await client({ type: 'join', connectionId: 'first', poolId: 'default' }); const assigned = await r.next('assigned');
    r.socket.send(JSON.stringify({ type: 'streaming', connectionId: 'first', leaseId: assigned.leaseId }));
    const waiting = await client({ type: 'join', connectionId: 'second', poolId: 'default' }); await waiting.next('queued');
    expect((await api('/instances/sender-1/drain', 'POST')).status).toBe(200);
    expect((await (await api()).json() as any).instances[0]).toMatchObject({ draining: true, connectionId: 'first', state: 'busy' });
    expect((await api('/sessions/first/end', 'POST')).status).toBe(200); await r.next('ended');
    const reset = await s.next('reset'); s.socket.send(JSON.stringify({ type: 'ready', resetId: reset.resetId })); await s.next('ready');
    expect((await (await api()).json() as any).summary).toMatchObject({ active: 0, idle: 0, queued: 1 });
    await api('/instances/sender-1/resume', 'POST'); expect((await waiting.next('assigned')).instanceId).toBe('sender-1');
    await api('/instances/sender-1/reset', 'POST'); await waiting.next('ended');
    const nextReset = await s.next('reset'); expect(nextReset.resetId).not.toBe(reset.resetId);
    s.socket.send(JSON.stringify({ type: 'ready', resetId: reset.resetId })); await s.next('error');
    expect((await (await api()).json() as any).instances[0].state).toBe('resetting');
    expect((await api('/sessions/first/end', 'POST')).status).toBe(404);
  });
  test('removing queued user advances positions and bounds event history', async () => {
    await boot();
    const a = await client({ type: 'join', connectionId: 'a', poolId: 'default' }); await a.next('queued');
    const b = await client({ type: 'join', connectionId: 'b', poolId: 'default' }); await b.next('queued');
    await api('/sessions/a/end', 'POST'); await a.next('ended'); expect((await b.next('queued')).position).toBe(1);
    await sender();
    for (let i = 0; i < 105; ++i) signaling.pool.manageInstance('sender-1', i % 2 ? 'drain' : 'resume');
    expect(signaling.pool.snapshot().events).toHaveLength(100);
  });
});

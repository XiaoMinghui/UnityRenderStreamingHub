/** @jest-environment node */
import { createServer, Server } from 'http';
import WebSocket = require('ws');
import WSSignaling from '../src/websocket';
import { createServer as createApp } from '../src/server';

type Client = { socket: WebSocket; messages: any[]; send: (message: any) => void; next: (type: string) => Promise<any> };
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('isolated instance pool over real WebSockets', () => {
  let server: Server, signaling: WSSignaling, url: string;
  const clients: Client[] = [];
  const token = 'test-only-sender-token';
  async function boot(mode = 'public', assignmentTimeoutMs = 30000, resetTimeoutMs = 30000, heartbeatIntervalMs = 20000) {
    server = createServer(createApp({ mode, type: 'websocket', logging: 'none', pool: true }));
    signaling = new WSSignaling(server, mode, 20000, 3, { senderToken: token, assignmentTimeoutMs, resetTimeoutMs, heartbeatIntervalMs });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `ws://127.0.0.1:${(server.address() as any).port}`;
  }
  afterEach(async () => {
    clients.splice(0).forEach(client => client.socket.terminate());
    signaling?.close();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  });
  async function client(path = '/pool'): Promise<Client> {
    const socket = new WebSocket(url + path);
    const messages: any[] = [];
    socket.on('message', data => messages.push(JSON.parse(String(data))));
    const result: Client = {
      socket, messages, send: message => socket.send(JSON.stringify(message)),
      next: async type => {
        const deadline = Date.now() + 2500;
        while (Date.now() < deadline) {
          const index = messages.findIndex(message => message.type === type);
          if (index >= 0) return messages.splice(index, 1)[0];
          await wait(5);
        }
        throw new Error(`Missing ${type}; received ${JSON.stringify(messages)}`);
      }
    };
    clients.push(result);
    await new Promise<void>(resolve => socket.once('open', resolve));
    return result;
  }
  async function sender(instanceId: string, poolId = 'default', ready = true) {
    const sender = await client();
    sender.send({ type: 'register', instanceId, poolId, token });
    await sender.next('registered');
    const reset = await sender.next('reset');
    if (ready) { sender.send({ type: 'ready', resetId: reset.resetId }); await sender.next('ready'); }
    return { ...sender, reset };
  }
  async function receiver(connectionId: string, poolId = 'default') {
    const receiver = await client();
    receiver.send({ type: 'join', connectionId, poolId });
    return receiver;
  }
  const signal = (type: string, assignment: any) => ({ type, leaseId: assignment.leaseId,
    data: { connectionId: assignment.connectionId, sdp: 'test-sdp', candidate: 'test-candidate' } });

  test.each(['public', 'private'])('legacy %s protocol and /config remain available when the pool is enabled', async mode => {
    await boot(mode);
    const pooled = await sender('pool-sender');
    const a = await client('/'), b = await client('/');
    a.send({ type: 'connect', connectionId: 'legacy' });
    expect((await a.next('connect')).polite).toBe(mode !== 'private');
    if (mode === 'private') { b.send({ type: 'connect', connectionId: 'legacy' }); await b.next('connect'); }
    a.send({ type: 'offer', data: { connectionId: 'legacy', sdp: 'old-offer' } });
    expect((await b.next('offer')).data.sdp).toBe('old-offer');
    b.send({ type: 'answer', data: { connectionId: 'legacy', sdp: 'old-answer' } });
    expect((await a.next('answer')).data.sdp).toBe('old-answer');
    a.send({ type: 'candidate', data: { connectionId: 'legacy', candidate: 'old-ice' } });
    expect((await b.next('candidate')).data.candidate).toBe('old-ice');
    expect(pooled.messages).toEqual([]);
    const config = await (await fetch(url.replace('ws:', 'http:') + '/config')).json() as any;
    expect(config).toMatchObject({ useWebSocket: true, startupMode: mode, poolEnabled: true });
    expect(JSON.stringify(config)).not.toContain(token);
  });

  test('two instances reserve separately; FIFO users wait for exact reset acknowledgement', async () => {
    await boot();
    const a = await sender('a'), b = await sender('b');
    const r1 = await receiver('r1'), r2 = await receiver('r2'), r3 = await receiver('r3'), r4 = await receiver('r4');
    const x = await r1.next('assigned'), y = await r2.next('assigned');
    expect(new Set([x.instanceId, y.instanceId]).size).toBe(2);
    expect((await r3.next('queued')).position).toBe(1);
    expect((await r4.next('queued')).position).toBe(2);
    const owned = x.instanceId === 'a' ? a : b;
    r1.send({ type: 'leave' });
    await owned.next('disconnect');
    const reset = await owned.next('reset');
    owned.send({ type: 'ready', resetId: owned.reset.resetId });
    expect((await owned.next('error')).message).toMatch(/Stale/);
    expect(r3.messages.some(message => message.type === 'assigned')).toBe(false);
    owned.send({ type: 'ready', resetId: reset.resetId });
    expect((await r3.next('assigned')).instanceId).toBe(x.instanceId);
    expect((await r4.next('queued')).position).toBe(1);
  });

  test('offers, renegotiation and ICE route only to the leased pair; guessed and stale leases fail', async () => {
    await boot();
    const a = await sender('a'), b = await sender('b');
    const r = await receiver('r');
    const assignment = await r.next('assigned');
    const owned = assignment.instanceId === 'a' ? a : b;
    const other = owned === a ? b : a;
    await owned.next('assigned');
    r.send(signal('offer', assignment));
    expect((await owned.next('offer')).data.polite).toBe(false);
    owned.send(signal('answer', assignment));
    expect((await r.next('answer')).from).toBe('r');
    owned.send(signal('offer', assignment));
    expect((await r.next('offer')).data.polite).toBe(true);
    other.send(signal('candidate', assignment));
    await other.next('error');
    r.send(signal('candidate', { ...assignment, leaseId: 'old' }));
    await r.next('error');
    r.send(signal('candidate', assignment));
    expect((await owned.next('candidate')).data.candidate).toBe('test-candidate');
    expect(other.messages.some(message => ['offer', 'answer', 'candidate'].includes(message.type))).toBe(false);
  });

  test('cancelled queue users are removed and different content pools cannot block each other', async () => {
    await boot();
    const unavailable = await receiver('other-content', 'other');
    await unavailable.next('queued');
    const r1 = await receiver('r1'), r2 = await receiver('r2');
    await r1.next('queued'); await r2.next('queued');
    r1.send({ type: 'leave' }); await r1.next('left');
    expect((await r2.next('queued')).position).toBe(1);
    await sender('new');
    expect((await r2.next('assigned')).instanceId).toBe('new');
    expect(unavailable.messages.some(message => message.type === 'assigned')).toBe(false);
  });

  test('startup expiry releases the lease, and overdue reset never makes an instance idle', async () => {
    await boot('public', 20, 20);
    const s = await sender('a');
    const r = await receiver('r'); await r.next('assigned');
    expect((await r.next('disconnect')).reason).toMatch(/timed out/);
    const reset = await s.next('reset');
    await s.next('unavailable');
    const waiting = await receiver('waiting'); await waiting.next('queued');
    s.send({ type: 'ready', resetId: reset.resetId });
    expect((await waiting.next('assigned')).instanceId).toBe('a');
  });

  test('decoded playback clears the reservation deadline; sender failure disconnects its receiver', async () => {
    await boot('public', 20);
    const s = await sender('a');
    const r = await receiver('r'), assignment = await r.next('assigned');
    r.send({ type: 'streaming', connectionId: 'r', leaseId: assignment.leaseId });
    await wait(350);
    expect(r.messages.some(message => message.type === 'disconnect')).toBe(false);
    s.socket.terminate();
    expect((await r.next('disconnect')).reason).toBe('Sender offline');
  });

  test('sender authentication, duplicate IDs, malformed data and duplicate join are rejected', async () => {
    await boot();
    const invalid = await client();
    const closed = new Promise<number>(resolve => invalid.socket.once('close', code => resolve(code)));
    invalid.send({ type: 'register', instanceId: 'a', poolId: 'default', token: 'wrong' });
    expect(await closed).toBe(1008);
    await sender('a');
    const duplicate = await client();
    const duplicateClosed = new Promise<number>(resolve => duplicate.socket.once('close', code => resolve(code)));
    duplicate.send({ type: 'register', instanceId: 'a', poolId: 'default', token });
    expect(await duplicateClosed).toBe(1008);
    const r = await receiver('r'); await r.next('assigned');
    r.send({ type: 'join', connectionId: 'another', poolId: 'default' }); await r.next('error');
    r.socket.send('{'); await r.next('error');
    r.send(null); await r.next('error');
    expect(r.socket.readyState).toBe(WebSocket.OPEN);
  });

  test('pool heartbeat removes a half-open queued client and advances responsive users', async () => {
    await boot('public', 30000, 30000, 20);
    const stale = await client();
    stale.socket.pong = () => {};
    const closed = new Promise<void>(resolve => stale.socket.once('close', () => resolve()));
    stale.send({ type: 'join', connectionId: 'stale', poolId: 'default' });
    await stale.next('queued');
    const survivor = await receiver('survivor');
    expect((await survivor.next('queued')).position).toBe(2);
    await closed;
    expect((await survivor.next('queued')).position).toBe(1);
    await sender('alive');
    expect((await survivor.next('assigned')).instanceId).toBe('alive');
  });
});

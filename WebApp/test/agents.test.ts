/** @jest-environment node */
import { createServer, Server } from 'http';
import WebSocket = require('ws');
import AgentHub from '../src/agents';
import { createServer as createApp } from '../src/server';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
describe('isolated authenticated process agent channel', () => {
  let hub: AgentHub, server: Server, url: string;
  const sockets: WebSocket[] = [];
  beforeEach(async () => {
    hub = new AgentHub('agent-secret', 150); server = createServer();
    server.on('upgrade', (request, socket, head) => hub.wss.handleUpgrade(request, socket, head, client => hub.wss.emit('connection', client, request)));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `ws://127.0.0.1:${(server.address() as any).port}/agent`;
  });
  afterEach(async () => {
    sockets.splice(0).forEach(s => s.terminate()); hub.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  async function agent(agentId: string, instanceId: string, token = 'agent-secret') {
    const socket = new WebSocket(url), messages: any[] = []; sockets.push(socket);
    socket.on('message', raw => messages.push(JSON.parse(String(raw))));
    const closed = new Promise<number>(resolve => socket.once('close', resolve));
    await new Promise<void>(resolve => socket.once('open', resolve));
    socket.send(JSON.stringify({ type: 'register', agentId, hostname: 'test-host', token, instances: [{ instanceId, poolId: 'default' }] }));
    async function next(type: string) {
      const end = Date.now() + 2000;
      while (Date.now() < end) { const index = messages.findIndex(m => m.type === type); if (index >= 0) return messages.splice(index, 1)[0]; await wait(5); }
      throw new Error('Missing ' + type);
    }
    return { socket, next, closed };
  }
  test('requires a third separate credential and rejects invalid registration and duplicate ownership', async () => {
    expect(() => createApp({ agents: true })).toThrow(/separate/);
    const bad = await agent('bad', 'bad', 'sender-secret'); expect(await bad.closed).toBe(1008);
    const a = await agent('a', 'one'); await a.next('registered');
    const duplicate = await agent('a', 'two'); expect(await duplicate.closed).toBe(1008);
    const conflicting = await agent('b', 'one'); expect(await conflicting.closed).toBe(1008);
    expect(hub.snapshot()).toHaveLength(1);
    expect(JSON.stringify(hub.snapshot())).not.toContain('agent-secret');
    expect(JSON.stringify(hub.snapshot())).not.toContain('socket');
  });
  test('only owning agent can complete a command; arbitrary operations and overlapping commands fail', async () => {
    const a = await agent('a', 'one'), b = await agent('b', 'two'); await a.next('registered'); await b.next('registered');
    await expect(hub.command('a', 'one', 'shell')).rejects.toThrow(/Unknown/);
    await expect(hub.command('a', 'two', 'start')).rejects.toThrow(/Unknown/);
    const result = hub.command('a', 'one', 'start'); const command = await a.next('command');
    await expect(hub.command('a', 'one', 'stop')).rejects.toThrow(/pending/);
    b.socket.send(JSON.stringify({ type: 'result', requestId: command.requestId, ok: true, output: 'forged' }));
    a.socket.send(JSON.stringify({ type: 'result', requestId: command.requestId, ok: true }));
    await expect(result).resolves.toEqual({ ok: true });
  });
  test('command timeout and disconnection fail explicitly; stale process status remains marked offline', async () => {
    const a = await agent('a', 'one'); await a.next('registered');
    await expect(hub.command('a', 'one', 'start')).rejects.toThrow(/timed out/);
    const result = hub.command('a', 'one', 'stop').catch(error => error as Error);
    a.socket.close(); expect((await result as Error).message).toMatch(/disconnected/);
    expect(hub.snapshot()[0].online).toBe(false);
    await expect(hub.command('a', 'one', 'logs')).rejects.toThrow(/offline/);
    const replacement = await agent('a', 'one'); await replacement.next('registered'); expect(hub.snapshot()).toHaveLength(1);
  });
  test('bounded process status and heartbeat; status cannot introduce an unconfigured process', async () => {
    const a = await agent('a', 'one'); await a.next('registered');
    a.socket.send(JSON.stringify({ type: 'ping' })); await a.next('pong');
    a.socket.send(JSON.stringify({ type: 'status', instances: [{ instanceId: 'one', state: 'running', pid: 123, restarts: 2, desiredRunning: true, lastError: 'x'.repeat(1000) }] }));
    await wait(20); expect(hub.snapshot()[0].instances[0]).toMatchObject({ state: 'running', pid: 123, restarts: 2 });
    expect(hub.snapshot()[0].instances[0].lastError).toHaveLength(500);
    a.socket.send(JSON.stringify({ type: 'status', instances: [{ instanceId: 'unconfigured', state: 'running' }] })); expect(await a.closed).toBe(1008);
  });
});

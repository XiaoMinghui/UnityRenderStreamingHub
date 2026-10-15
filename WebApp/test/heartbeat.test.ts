/** @jest-environment node */
import { createServer, Server } from 'http';
import WebSocket = require('ws');
import WSSignaling from '../src/websocket';

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
describe('live WebSocket heartbeat and stale registration cleanup', () => {
  let server: Server;
  let signaling: WSSignaling;
  const sockets: WebSocket[] = [];
  let url: string;
  beforeEach(async () => {
    server = createServer();
    signaling = new WSSignaling(server, 'public', 50, 3);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `ws://127.0.0.1:${(server.address() as any).port}`;
  });
  afterEach(async () => {
    sockets.splice(0).forEach(socket => socket.terminate());
    signaling.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  async function connect(autoPong = true): Promise<WebSocket> {
    const socket = new WebSocket(url);
    // ws 8.8 predates the autoPong option. Suppress its public pong method
    // to reproduce a half-open/non-responsive client over a real TCP socket.
    if (!autoPong) socket.pong = () => {};
    sockets.push(socket);
    await new Promise<void>(resolve => socket.once('open', resolve));
    return socket;
  }
  test('responsive clients survive several intervals and browser JSON ping receives pong', async () => {
    const client = await connect();
    const reply = new Promise<any>(resolve => client.once('message', data => resolve(JSON.parse(String(data)))));
    client.send(JSON.stringify({ type: 'ping', id: 42 }));
    expect(await reply).toEqual({ type: 'pong', id: 42 });
    await wait(350);
    expect(client.readyState).toBe(WebSocket.OPEN);
  });
  test('missing pong terminates the client and notifies the paired peer', async () => {
    const stale = await connect(false);
    const peer = await connect();
    stale.send(JSON.stringify({ type: 'connect', connectionId: 'stale' }));
    await wait(10);
    stale.send(JSON.stringify({ type: 'offer', data: { connectionId: 'stale', sdp: 'test' } }));
    await wait(10);
    peer.send(JSON.stringify({ type: 'answer', data: { connectionId: 'stale', sdp: 'answer' } }));
    const messages: any[] = [];
    peer.on('message', data => messages.push(JSON.parse(String(data))));
    await new Promise<void>(resolve => stale.once('close', () => resolve()));
    await wait(20);
    expect(messages).toContainEqual({ type: 'disconnect', connectionId: 'stale' });
    expect(peer.readyState).toBe(WebSocket.OPEN);
  });
  test('malformed JSON does not crash the server', async () => {
    const client = await connect();
    const reply = new Promise<any>(resolve => client.once('message', data => resolve(JSON.parse(String(data)))));
    client.send('{');
    expect((await reply).type).toBe('error');
    expect(client.readyState).toBe(WebSocket.OPEN);
  });
});

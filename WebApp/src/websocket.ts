import * as websocket from "ws";
import { Server } from 'http';
import * as handler from "./class/websockethandler";
import PoolSignaling, { PoolOptions } from './pool';
import AgentHub from './agents';

export default class WSSignaling {
  server: Server;
  wss: websocket.Server;
  private heartbeat: ReturnType<typeof setInterval>;
  readonly pool?: PoolSignaling;
  readonly agents?: AgentHub;
  private upgrade: (...args: any[]) => void;

  constructor(server: Server, mode: string, heartbeatInterval = 20000, maxMissedPongs = 3, poolOptions?: PoolOptions, agentToken?: string) {
    this.server = server;
    // Keep the legacy upgrade listener exactly as before unless explicitly enabled.
    this.wss = new websocket.Server(poolOptions ? { noServer: true } : { server });
    if (poolOptions) {
      this.pool = new PoolSignaling(poolOptions);
      if (agentToken) this.agents = new AgentHub(agentToken);
      this.upgrade = (request, socket, head) => {
        const pathname = request.url?.split('?')[0];
        if (pathname === '/agent' && !this.agents) { socket.destroy(); return; }
        const target = pathname === '/pool' ? this.pool.wss : pathname === '/agent' ? this.agents.wss : this.wss;
        target.handleUpgrade(request, socket, head, client => target.emit('connection', client, request));
      };
      server.on('upgrade', this.upgrade);
    }
    handler.reset(mode);

    const misses = new Map<websocket, number>();
    this.heartbeat = setInterval(() => {
      this.wss.clients.forEach(ws => {
        const missed = misses.get(ws) || 0;
        if (missed >= maxMissedPongs) {
          ws.terminate();
          return;
        }
        if (ws.readyState === websocket.OPEN) {
          misses.set(ws, missed + 1);
          ws.ping();
        }
      });
    }, heartbeatInterval);
    this.heartbeat.unref();
    this.wss.once('close', () => clearInterval(this.heartbeat));

    this.wss.on('connection', (socket: websocket) => {
      const ws = socket as unknown as WebSocket;
      misses.set(socket, 0);
      socket.on('pong', () => misses.set(socket, 0));
      socket.on('error', () => socket.terminate());

      handler.add(ws);

      ws.onclose = (): void => {
        misses.delete(socket);
        handler.remove(ws);
      };

      ws.onmessage = (event: MessageEvent): void => {

        // type: connect, disconnect JSON Schema
        // connectionId: connect or disconnect connectionId

        // type: offer, answer, candidate JSON Schema
        // from: from connection id
        // to: to connection id
        // data: any message data structure

        let msg;
        try {
          msg = JSON.parse(String(event.data));
        } catch (_) {
          socket.send(JSON.stringify({ type: 'error', message: 'Invalid signaling JSON' }));
          return;
        }
        if (!msg || !this) {
          return;
        }

        if ((msg.type === 'connect' || msg.type === 'disconnect') &&
            (typeof msg.connectionId !== 'string' || !msg.connectionId || msg.connectionId.length > 128)) return;
        if (['offer', 'answer', 'candidate'].indexOf(msg.type) >= 0 &&
            (!msg.data || typeof msg.data.connectionId !== 'string')) return;

        switch (msg.type) {
          case 'ping':
            // Browsers cannot originate protocol Ping frames. An application
            // round trip also lets them detect a half-open signaling socket.
            socket.send(JSON.stringify({ type: 'pong', id: msg.id }));
            break;
          case "connect":
            handler.onConnect(ws, msg.connectionId);
            break;
          case "disconnect":
            handler.onDisconnect(ws, msg.connectionId);
            break;
          case "offer":
            handler.onOffer(ws, msg.data);
            break;
          case "answer":
            handler.onAnswer(ws, msg.data);
            break;
          case "candidate":
            handler.onCandidate(ws, msg.data);
            break;
          default:
            break;
        }
      };
    });
  }

  close(): void {
    if (this.upgrade) this.server.removeListener('upgrade', this.upgrade);
    this.pool?.close();
    this.agents?.close();
    clearInterval(this.heartbeat);
    this.wss.clients.forEach(client => client.terminate());
    this.wss.close();
  }
}

import * as WebSocket from 'ws';
import { randomBytes, timingSafeEqual } from 'crypto';

export interface PoolOptions {
  senderToken: string;
  assignmentTimeoutMs?: number;
  resetTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  maxQueueLength?: number;
}

interface Sender {
  socket: WebSocket;
  instanceId: string;
  poolId: string;
  state: 'resetting' | 'idle' | 'reserved' | 'busy' | 'unavailable';
  resetId?: string;
  deadline?: number;
  session?: Session;
}

interface Session {
  socket: WebSocket;
  connectionId: string;
  poolId: string;
  leaseId?: string;
  sender?: Sender;
  position?: number;
}

const id = () => randomBytes(16).toString('hex');
const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(value);

/** An opt-in signaling namespace. Legacy sockets never enter these maps. */
export default class PoolSignaling {
  readonly wss = new WebSocket.Server({ noServer: true, maxPayload: 1024 * 1024 });
  private senders = new Map<WebSocket, Sender>();
  private sessions = new Map<WebSocket, Session>();
  private queue: Session[] = [];
  private timer: ReturnType<typeof setInterval>;
  private heartbeat: ReturnType<typeof setInterval>;

  constructor(private options: PoolOptions) {
    if (!options.senderToken) throw new Error('Set RENDERSTREAMING_POOL_TOKEN before enabling the instance pool.');
    const misses = new Map<WebSocket, number>();
    this.wss.on('connection', socket => {
      misses.set(socket, 0);
      const registration = setTimeout(() => {
        if (!this.senders.has(socket) && !this.sessions.has(socket)) socket.close(1008, 'Registration timeout');
      }, 10000);
      registration.unref();
      socket.on('pong', () => misses.set(socket, 0));
      socket.on('error', () => socket.terminate());
      socket.on('close', () => {
        clearTimeout(registration);
        misses.delete(socket);
        this.remove(socket);
      });
      socket.on('message', data => {
        try {
          const message = JSON.parse(String(data));
          if (!message || typeof message !== 'object') throw new Error();
          this.receive(socket, message);
        } catch (_) { this.error(socket, 'Invalid pool message'); }
      });
    });
    this.heartbeat = setInterval(() => {
      this.wss.clients.forEach(socket => {
        const missed = misses.get(socket) || 0;
        if (missed >= 3) { socket.terminate(); return; }
        if (socket.readyState === WebSocket.OPEN) {
          misses.set(socket, missed + 1);
          socket.ping();
        }
      });
    }, options.heartbeatIntervalMs ?? 20000);
    this.heartbeat.unref();
    this.timer = setInterval(() => this.sweep(), 250);
    this.timer.unref();
  }

  private send(socket: WebSocket, message: object): void {
    if (socket.readyState !== WebSocket.OPEN) return;
    try { socket.send(JSON.stringify(message)); } catch (_) { socket.terminate(); }
  }

  private error(socket: WebSocket, message: string): void {
    this.send(socket, { type: 'error', message });
  }

  private receive(socket: WebSocket, message: any): void {
    if (message.type === 'ping') { this.send(socket, { type: 'pong', id: message.id }); return; }
    if (message.type === 'register') { this.register(socket, message); return; }
    if (message.type === 'join') { this.join(socket, message); return; }
    const sender = this.senders.get(socket);
    const session = this.sessions.get(socket);
    if (message.type === 'ready' && sender) {
      if (!sender.resetId || message.resetId !== sender.resetId ||
          (sender.state !== 'resetting' && sender.state !== 'unavailable')) {
        this.error(socket, 'Stale reset acknowledgement'); return;
      }
      sender.resetId = undefined;
      sender.deadline = undefined;
      sender.state = 'idle';
      this.send(socket, { type: 'ready' });
      this.schedule();
      return;
    }
    if (message.type === 'leave' && session) {
      this.release(session, 'Receiver left');
      return;
    }
    const pair = sender?.session || session;
    if (!pair?.sender || pair.connectionId !== (message.connectionId || message.data?.connectionId) ||
        !pair.leaseId || message.leaseId !== pair.leaseId) {
      this.error(socket, 'No matching pool lease'); return;
    }
    if (message.type === 'disconnect') { this.release(pair, 'Stream disconnected'); return; }
    if (message.type === 'streaming' && session) {
      pair.sender.state = 'busy';
      pair.sender.deadline = undefined;
      return;
    }
    if (!['offer', 'answer', 'candidate'].includes(message.type) || !message.data ||
        message.data.connectionId !== pair.connectionId ||
        (message.type === 'candidate' ? typeof message.data.candidate !== 'string' : typeof message.data.sdp !== 'string')) {
      this.error(socket, 'Invalid pool signal'); return;
    }
    this.send(sender ? pair.socket : pair.sender.socket, {
      type: message.type, from: pair.connectionId, to: '', leaseId: pair.leaseId,
      data: { ...message.data, polite: !!sender }
    });
  }

  private register(socket: WebSocket, message: any): void {
    const token = typeof message.token === 'string' ? Buffer.from(message.token) : Buffer.alloc(0);
    const expected = Buffer.from(this.options.senderToken);
    if (token.length !== expected.length || !timingSafeEqual(token, expected)) {
      socket.close(1008, 'Sender authentication failed'); return;
    }
    if (this.senders.has(socket) || this.sessions.has(socket) || !validId(message.instanceId) || !validId(message.poolId)) {
      this.error(socket, 'Invalid or duplicate registration'); return;
    }
    if (Array.from(this.senders.values()).some(sender => sender.instanceId === message.instanceId)) {
      socket.close(1008, 'Instance ID is already registered'); return;
    }
    const sender: Sender = { socket, instanceId: message.instanceId, poolId: message.poolId, state: 'resetting' };
    this.senders.set(socket, sender);
    this.send(socket, { type: 'registered', instanceId: sender.instanceId });
    this.reset(sender);
  }

  private join(socket: WebSocket, message: any): void {
    if (this.senders.has(socket) || this.sessions.has(socket) || !validId(message.connectionId) || !validId(message.poolId)) {
      this.error(socket, 'Invalid or duplicate join'); return;
    }
    if (Array.from(this.sessions.values()).some(session => session.connectionId === message.connectionId)) {
      this.error(socket, 'Connection ID is already used'); return;
    }
    if (this.queue.length >= (this.options.maxQueueLength ?? 1000)) {
      socket.close(1013, 'Pool queue is full'); return;
    }
    const session: Session = { socket, connectionId: message.connectionId, poolId: message.poolId };
    this.sessions.set(socket, session);
    this.queue.push(session);
    this.schedule();
  }

  private schedule(): void {
    // Reserving is synchronous: a second join cannot select the same sender.
    for (const session of this.queue.slice()) {
      if (session.socket.readyState !== WebSocket.OPEN) continue;
      const sender = Array.from(this.senders.values()).find(candidate =>
        candidate.poolId === session.poolId && candidate.state === 'idle' && candidate.socket.readyState === WebSocket.OPEN);
      if (!sender) continue;
      this.queue.splice(this.queue.indexOf(session), 1);
      sender.state = 'reserved';
      sender.deadline = Date.now() + (this.options.assignmentTimeoutMs ?? 30000);
      sender.session = session;
      session.sender = sender;
      session.leaseId = id();
      const assignment = { type: 'assigned', connectionId: session.connectionId, leaseId: session.leaseId, instanceId: sender.instanceId };
      this.send(sender.socket, assignment);
      this.send(session.socket, assignment);
      // Existing RenderStreaming creates its peer and input channel on connect.
      this.send(session.socket, { type: 'connect', connectionId: session.connectionId, polite: true });
    }
    const positions = new Map<string, number>();
    this.queue.forEach(session => {
      const position = (positions.get(session.poolId) || 0) + 1;
      positions.set(session.poolId, position);
      if (session.position !== position) {
        session.position = position;
        this.send(session.socket, { type: 'queued', position, poolId: session.poolId });
      }
    });
  }

  private reset(sender: Sender): void {
    sender.state = 'resetting';
    sender.resetId = id();
    sender.deadline = Date.now() + (this.options.resetTimeoutMs ?? 30000);
    this.send(sender.socket, { type: 'reset', resetId: sender.resetId });
  }

  private release(session: Session, reason: string): void {
    this.sessions.delete(session.socket);
    this.queue = this.queue.filter(candidate => candidate !== session);
    const sender = session.sender;
    if (sender) {
      sender.session = undefined;
      session.sender = undefined;
      const message = { type: 'disconnect', connectionId: session.connectionId, leaseId: session.leaseId, reason };
      this.send(session.socket, message);
      this.send(sender.socket, message);
      if (this.senders.has(sender.socket)) this.reset(sender);
    } else this.send(session.socket, { type: 'left' });
    this.schedule();
  }

  private remove(socket: WebSocket): void {
    const sender = this.senders.get(socket);
    this.senders.delete(socket);
    const session = this.sessions.get(socket) || sender?.session;
    if (session) this.release(session, sender ? 'Sender offline' : 'Receiver offline');
  }

  private sweep(): void {
    const now = Date.now();
    this.senders.forEach(sender => {
      if (!sender.deadline || now < sender.deadline) return;
      if (sender.state === 'reserved' && sender.session) this.release(sender.session, 'Stream startup timed out');
      else if (sender.state === 'resetting') {
        // Never recycle an instance whose application has not confirmed reset.
        sender.state = 'unavailable';
        sender.deadline = undefined;
        this.send(sender.socket, { type: 'unavailable', reason: 'Reset acknowledgement timed out' });
      }
    });
  }

  close(): void {
    clearInterval(this.timer);
    clearInterval(this.heartbeat);
    this.senders.clear();
    this.sessions.clear();
    this.queue = [];
    this.wss.clients.forEach(socket => socket.terminate());
    this.wss.close();
  }
}

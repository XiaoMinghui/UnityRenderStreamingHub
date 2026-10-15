import * as WebSocket from 'ws';
import { randomBytes, timingSafeEqual } from 'crypto';

export interface PoolOptions {
  senderToken: string;
  assignmentTimeoutMs?: number;
  resetTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  maxQueueLength?: number;
  resumeGraceMs?: number;
}

interface Sender {
  socket: WebSocket;
  instanceId: string;
  poolId: string;
  state: 'resetting' | 'idle' | 'reserved' | 'busy' | 'unavailable';
  resetId?: string;
  deadline?: number;
  session?: Session;
  draining: boolean;
  connectedAt: number;
  lastError?: string;
}

interface Session {
  socket: WebSocket;
  connectionId: string;
  poolId: string;
  leaseId?: string;
  sender?: Sender;
  position?: number;
  joinedAt: number;
  assignedAt?: number;
  streamingAt?: number;
  resumeToken?: string;
  detachedUntil?: number;
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
  private drained = new Set<string>();
  private resumable = new Map<string, Session>();
  private ended = new Map<string, number>();
  private timer: ReturnType<typeof setInterval>;
  private heartbeat: ReturnType<typeof setInterval>;
  private events: { at: number; type: string; subject: string; message: string }[] = [];

  private record(type: string, subject: string, message: string): void {
    this.events.unshift({ at: Date.now(), type, subject, message });
    this.events.length = Math.min(this.events.length, 100);
  }

  /** Management snapshots intentionally exclude sockets, tokens and lease/reset tickets. */
  snapshot() {
    const senders = Array.from(this.senders.values());
    const sessions = this.allSessions();
    return {
      at: Date.now(),
      summary: { online: senders.length, idle: senders.filter(s => s.state === 'idle' && !s.draining).length,
        active: sessions.filter(s => !!s.sender).length, queued: this.queue.length,
        unavailable: senders.filter(s => s.state === 'unavailable').length },
      instances: senders.map(s => ({ instanceId: s.instanceId, poolId: s.poolId, state: s.state,
        draining: s.draining, connectedAt: s.connectedAt, connectionId: s.session?.connectionId,
        lastError: s.lastError })),
      sessions: sessions.map(s => ({ connectionId: s.connectionId, poolId: s.poolId,
        instanceId: s.sender?.instanceId, state: s.detachedUntil ? 'reconnecting' : s.sender ? (s.sender.state === 'busy' ? 'streaming' : 'connecting') : 'queued',
        position: s.sender ? undefined : s.position, joinedAt: s.joinedAt,
        assignedAt: s.assignedAt, streamingAt: s.streamingAt, reconnectUntil: s.detachedUntil })),
      events: this.events.slice()
    };
  }

  manageInstance(instanceId: string, action: string): boolean {
    const sender = Array.from(this.senders.values()).find(s => s.instanceId === instanceId);
    if (!sender) return false;
    if (action === 'drain' || action === 'resume') {
      this.setDraining(instanceId, action === 'drain');
      this.record(action, instanceId, sender.draining ? 'Stopped accepting new sessions' : 'Accepting new sessions');
      this.schedule();
    } else if (action === 'reset') {
      if (sender.session) this.endSession(sender.session.connectionId);
      else this.reset(sender);
      this.record(action, instanceId, 'Preparation requested by administrator');
    } else return false;
    return true;
  }

  isDraining(instanceId: string): boolean { return this.drained.has(instanceId); }

  setDraining(instanceId: string, draining: boolean): void {
    if (draining) this.drained.add(instanceId); else this.drained.delete(instanceId);
    const sender = Array.from(this.senders.values()).find(s => s.instanceId === instanceId);
    if (sender) sender.draining = draining;
    this.schedule();
  }

  endSession(connectionId: string): boolean {
    const session = this.allSessions().find(s => s.connectionId === connectionId);
    if (!session) return false;
    this.send(session.socket, { type: 'ended', reason: 'Session ended by administrator' });
    if (session.resumeToken) {
      this.ended.set(session.resumeToken, Date.now() + Math.max(300000, this.options.resumeGraceMs ?? 30000));
      if (this.ended.size > 1000) this.ended.delete(this.ended.keys().next().value);
    }
    this.release(session, 'Session ended by administrator');
    session.socket.close(1000, 'Session ended by administrator');
    return true;
  }

  constructor(private options: PoolOptions) {
    if (!options.senderToken) throw new Error('Set RENDERSTREAMING_POOL_TOKEN before enabling the instance pool.');
    if (options.resumeGraceMs !== undefined && (!Number.isInteger(options.resumeGraceMs) || options.resumeGraceMs < 0 || options.resumeGraceMs > 300000))
      throw new Error('Pool resume grace must be an integer from 0 to 300000 milliseconds.');
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

  private allSessions(): Session[] {
    return Array.from(new Set([...Array.from(this.sessions.values()), ...Array.from(this.resumable.values())]));
  }

  private detach(session: Session): void {
    if (session.detachedUntil) return;
    this.sessions.delete(session.socket);
    session.detachedUntil = Date.now() + (this.options.resumeGraceMs ?? 30000);
    const sender = session.sender;
    if (sender) {
      // Dispose only transport resources; the application reset hook must not run.
      this.send(sender.socket, { type: 'disconnect', connectionId: session.connectionId, leaseId: session.leaseId,
        reason: 'Receiver reconnecting' });
      session.leaseId = undefined;
      sender.state = 'reserved'; sender.deadline = undefined;
    }
    this.record('reconnecting', session.connectionId, 'Receiver session retained temporarily');
    this.schedule();
  }

  private attach(session: Session): void {
    if (!session.sender) return;
    const sender = session.sender;
    session.leaseId = id();
    sender.state = 'reserved'; sender.deadline = Date.now() + (this.options.assignmentTimeoutMs ?? 30000);
    const assignment = { type: 'assigned', connectionId: session.connectionId, leaseId: session.leaseId,
      instanceId: sender.instanceId };
    this.send(sender.socket, assignment); this.send(session.socket, assignment);
    this.send(session.socket, { type: 'connect', connectionId: session.connectionId, polite: true });
  }

  private receive(socket: WebSocket, message: any): void {
    if (message.type === 'ping') { this.send(socket, { type: 'pong', id: message.id }); return; }
    if (message.type === 'register') { this.register(socket, message); return; }
    if (message.type === 'join') { this.join(socket, message); return; }
    const sender = this.senders.get(socket);
    const session = this.sessions.get(socket);
    if (message.type === 'suspend' && session?.resumeToken) {
      this.detach(session); socket.close(1000, 'Receiver reconnecting'); return;
    }
    if (message.type === 'ready' && sender) {
      if (!sender.resetId || message.resetId !== sender.resetId ||
          (sender.state !== 'resetting' && sender.state !== 'unavailable')) {
        this.error(socket, 'Stale reset acknowledgement'); return;
      }
      sender.resetId = undefined;
      sender.deadline = undefined;
      sender.state = 'idle';
      sender.lastError = undefined;
      this.record('ready', sender.instanceId, 'Instance ready');
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
    if (message.type === 'disconnect') {
      if (pair.resumeToken) { this.detach(pair); pair.socket.close(4001, 'Reconnect media session'); }
      else this.release(pair, 'Stream disconnected');
      return;
    }
    if (message.type === 'streaming' && session) {
      pair.sender.state = 'busy';
      pair.sender.deadline = undefined;
      if (!pair.streamingAt) {
        pair.streamingAt = Date.now();
        this.record('streaming', pair.connectionId, 'Receiver confirmed decoded playback');
      }
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
    const sender: Sender = { socket, instanceId: message.instanceId, poolId: message.poolId, state: 'resetting',
      draining: this.drained.has(message.instanceId), connectedAt: Date.now() };
    this.senders.set(socket, sender);
    this.record('registered', sender.instanceId, 'Sender registered');
    this.send(socket, { type: 'registered', instanceId: sender.instanceId });
    this.reset(sender);
  }

  private join(socket: WebSocket, message: any): void {
    if (this.senders.has(socket) || this.sessions.has(socket) || !validId(message.connectionId) || !validId(message.poolId)) {
      this.error(socket, 'Invalid or duplicate join'); return;
    }
    if (this.allSessions().some(session => session.connectionId === message.connectionId &&
        (!message.resumeToken || session.resumeToken !== message.resumeToken))) {
      this.error(socket, 'Connection ID is already used'); return;
    }
    if (message.resumeToken !== undefined) {
      if (typeof message.resumeToken !== 'string' || !/^[a-f0-9]{32}$/.test(message.resumeToken)) {
        this.error(socket, 'Invalid resume credential'); return;
      }
      if (this.ended.has(message.resumeToken)) {
        this.send(socket, { type: 'ended', reason: 'Session ended by administrator' }); socket.close(1000); return;
      }
      const previous = this.resumable.get(message.resumeToken);
      if (previous && previous.poolId !== message.poolId) { this.error(socket, 'Resume pool does not match'); return; }
      if (previous?.detachedUntil && previous.detachedUntil <= Date.now()) this.release(previous, 'Receiver resume grace expired');
      else if (previous) {
        const oldSocket = previous.socket;
        this.detach(previous);
        previous.socket = socket; previous.detachedUntil = undefined;
        previous.connectionId = message.connectionId;
        this.sessions.set(socket, previous);
        this.send(socket, { type: 'session', resumeToken: previous.resumeToken, graceMs: this.options.resumeGraceMs ?? 30000, resumed: true });
        if (oldSocket !== socket) oldSocket.close(4001, 'Session resumed on another connection');
        this.record('resumed', previous.connectionId, 'Receiver recovered its session');
        if (previous.sender) this.attach(previous);
        else { previous.position = undefined; this.schedule(); }
        return;
      }
      this.send(socket, { type: 'resume-expired' });
    }
    if (this.queue.length >= (this.options.maxQueueLength ?? 1000)) {
      socket.close(1013, 'Pool queue is full'); return;
    }
    const session: Session = { socket, connectionId: message.connectionId, poolId: message.poolId, joinedAt: Date.now() };
    if (message.resumable === true && (this.options.resumeGraceMs ?? 30000) > 0) {
      session.resumeToken = id(); this.resumable.set(session.resumeToken, session);
    }
    this.sessions.set(socket, session);
    if (message.resumable === true) this.send(socket, { type: 'session', resumeToken: session.resumeToken,
      graceMs: this.options.resumeGraceMs ?? 30000, resumed: false });
    this.queue.push(session);
    this.record('joined', session.connectionId, 'Receiver joined ' + session.poolId);
    this.schedule();
  }

  private schedule(): void {
    // Reserving is synchronous: a second join cannot select the same sender.
    for (const session of this.queue.slice()) {
      if (session.detachedUntil || session.socket.readyState !== WebSocket.OPEN) continue;
      const sender = Array.from(this.senders.values()).find(candidate =>
        candidate.poolId === session.poolId && candidate.state === 'idle' && !candidate.draining && candidate.socket.readyState === WebSocket.OPEN);
      if (!sender) continue;
      this.queue.splice(this.queue.indexOf(session), 1);
      sender.state = 'reserved';
      sender.deadline = Date.now() + (this.options.assignmentTimeoutMs ?? 30000);
      sender.session = session;
      session.sender = sender;
      session.assignedAt = Date.now();
      this.record('assigned', session.connectionId, 'Assigned to ' + sender.instanceId);
      this.attach(session);
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
    this.record('released', session.connectionId, reason);
    this.sessions.delete(session.socket);
    if (session.resumeToken) this.resumable.delete(session.resumeToken);
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
    if (sender) this.record('offline', sender.instanceId, 'Sender disconnected');
    this.senders.delete(socket);
    const session = this.sessions.get(socket) || sender?.session;
    if (session) {
      if (!sender && session.resumeToken) this.detach(session);
      else this.release(session, sender ? 'Sender offline' : 'Receiver offline');
    }
  }

  private sweep(): void {
    const now = Date.now();
    this.resumable.forEach(session => {
      if (session.detachedUntil && session.detachedUntil <= now) this.release(session, 'Receiver resume grace expired');
    });
    this.ended.forEach((expires, token) => { if (expires <= now) this.ended.delete(token); });
    this.senders.forEach(sender => {
      if (!sender.deadline || now < sender.deadline) return;
      if (sender.state === 'reserved' && sender.session) this.release(sender.session, 'Stream startup timed out');
      else if (sender.state === 'resetting') {
        // Never recycle an instance whose application has not confirmed reset.
        sender.state = 'unavailable';
        sender.deadline = undefined;
        sender.lastError = 'Reset acknowledgement timed out';
        this.record('unavailable', sender.instanceId, sender.lastError);
        this.send(sender.socket, { type: 'unavailable', reason: 'Reset acknowledgement timed out' });
      }
    });
  }

  close(): void {
    clearInterval(this.timer);
    clearInterval(this.heartbeat);
    this.senders.clear();
    this.sessions.clear();
    this.resumable.clear(); this.ended.clear();
    this.drained.clear();
    this.queue = [];
    this.wss.clients.forEach(socket => socket.terminate());
    this.wss.close();
  }
}

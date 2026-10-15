import * as WebSocket from 'ws';
import { randomBytes } from 'crypto';
import { tokenMatches } from './admin';

const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(value);
const states = ['stopped', 'starting', 'running', 'stopping', 'backoff', 'failed'];
interface ManagedInstance {
  instanceId: string; poolId: string; state: string; desiredRunning: boolean;
  pid?: number; restarts?: number; lastError?: string; lastExit?: string;
}
interface Agent {
  agentId: string; hostname: string; socket?: WebSocket; connectedAt: number; lastSeen: number;
  instances: ManagedInstance[];
}
interface Pending { agent: Agent; instanceId: string; timer: ReturnType<typeof setTimeout>;
  resolve: (value: { ok: boolean; output?: string }) => void; reject: (error: Error) => void; }

/** Agents execute only operations on their locally configured instance IDs. */
export default class AgentHub {
  readonly wss = new WebSocket.Server({ noServer: true, maxPayload: 256 * 1024 });
  private agents = new Map<string, Agent>();
  private pending = new Map<string, Pending>();
  private heartbeat: ReturnType<typeof setInterval>;
  private events: { at: number; type: string; subject: string; message: string }[] = [];
  private record(type: string, subject: string, message: string): void {
    this.events.unshift({ at: Date.now(), type, subject, message }); this.events.length = Math.min(100, this.events.length);
  }
  recentEvents() { return this.events.slice(); }
  constructor(private token: string, private commandTimeout = 15000, heartbeatInterval = 20000) {
    if (!token) throw new Error('Set RENDERSTREAMING_AGENT_TOKEN before enabling agents.');
    const missed = new Map<WebSocket, number>();
    this.wss.on('connection', socket => {
      let agent: Agent;
      missed.set(socket, 0);
      const registration = setTimeout(() => socket.close(1008, 'Agent registration timeout'), 10000); registration.unref();
      socket.on('pong', () => missed.set(socket, 0));
      socket.on('error', () => socket.terminate());
      socket.on('message', raw => {
        try {
          const message = JSON.parse(String(raw));
          if (!agent) {
            if (message?.type !== 'register' || !tokenMatches(message.token, this.token) || !validId(message.agentId) ||
                typeof message.hostname !== 'string' || message.hostname.length > 128 ||
                !Array.isArray(message.instances) || !message.instances.length || message.instances.length > 200)
              throw new Error('Invalid agent registration');
            const existing = this.agents.get(message.agentId);
            if (existing?.socket?.readyState === WebSocket.OPEN || (!existing && this.agents.size >= 100))
              throw new Error('Agent ID already connected or agent limit reached');
            const ids = new Set<string>();
            const instances: ManagedInstance[] = message.instances.map((entry: any) => {
              if (!validId(entry.instanceId) || !validId(entry.poolId) || ids.has(entry.instanceId)) throw new Error('Invalid managed instance');
              for (const other of Array.from(this.agents.values())) {
                if (other.agentId !== message.agentId && other.instances.some(i => i.instanceId === entry.instanceId))
                  throw new Error('Instance ID belongs to another agent');
              }
              ids.add(entry.instanceId);
              return { instanceId: entry.instanceId, poolId: entry.poolId, state: 'stopped', desiredRunning: false };
            });
            agent = { agentId: message.agentId, hostname: message.hostname, socket,
              connectedAt: Date.now(), lastSeen: Date.now(), instances };
            this.agents.set(agent.agentId, agent); clearTimeout(registration);
            this.record('agent-online', agent.agentId, 'Process agent connected');
            socket.send(JSON.stringify({ type: 'registered' }));
          } else if (message?.type === 'ping') {
            agent.lastSeen = Date.now(); socket.send(JSON.stringify({ type: 'pong' }));
          } else if (message?.type === 'status') {
            if (!Array.isArray(message.instances) || message.instances.length !== agent.instances.length) throw new Error('Invalid status');
            const ids = new Set();
            for (const entry of message.instances) {
              const instance = agent.instances.find(i => i.instanceId === entry.instanceId);
              if (!instance || ids.has(entry.instanceId) || !states.includes(entry.state)) throw new Error('Unknown instance status');
              ids.add(entry.instanceId); instance.state = entry.state; instance.desiredRunning = entry.desiredRunning === true;
              instance.pid = Number.isInteger(entry.pid) && entry.pid > 0 ? entry.pid : undefined;
              instance.restarts = Number.isInteger(entry.restarts) && entry.restarts >= 0 ? entry.restarts : 0;
              instance.lastError = typeof entry.lastError === 'string' ? entry.lastError.slice(0, 500) : undefined;
              instance.lastExit = typeof entry.lastExit === 'string' ? entry.lastExit.slice(0, 128) : undefined;
            }
            agent.lastSeen = Date.now();
          } else if (message?.type === 'result') {
            const pending = this.pending.get(message.requestId);
            if (!pending || pending.agent !== agent) return;
            clearTimeout(pending.timer); this.pending.delete(message.requestId);
            this.record('process-result', pending.instanceId, message.ok ? 'Process operation completed' : 'Process operation failed');
            if (!message.ok) pending.reject(new Error('Agent operation failed; inspect process status and local logs'));
            else pending.resolve({ ok: true, output: typeof message.output === 'string' ? message.output.slice(-8192) : undefined });
          }
        } catch (_) { socket.close(1008, 'Invalid agent message or authentication'); }
      });
      socket.on('close', () => {
        clearTimeout(registration); missed.delete(socket);
        if (agent?.socket === socket) {
          agent.socket = undefined;
          this.record('agent-offline', agent.agentId, 'Process state is unknown until agent reconnects');
          this.pending.forEach((p, key) => {
            if (p.agent !== agent) return;
            clearTimeout(p.timer); this.pending.delete(key); p.reject(new Error('Agent disconnected; process outcome is unknown'));
          });
        }
      });
    });
    this.heartbeat = setInterval(() => {
      this.wss.clients.forEach(socket => {
        const count = missed.get(socket) || 0;
        if (count >= 3) { socket.terminate(); return; }
        if (socket.readyState === WebSocket.OPEN) { missed.set(socket, count + 1); socket.ping(); }
      });
    }, heartbeatInterval); this.heartbeat.unref();
  }
  snapshot() {
    return Array.from(this.agents.values()).map(a => ({ agentId: a.agentId, hostname: a.hostname,
      online: !!a.socket && a.socket.readyState === WebSocket.OPEN, connectedAt: a.connectedAt, lastSeen: a.lastSeen,
      instances: a.instances.map(i => ({ ...i })) }));
  }
  owns(agentId: string, instanceId: string): boolean {
    return !!this.agents.get(agentId)?.instances.some(i => i.instanceId === instanceId);
  }
  command(agentId: string, instanceId: string, action: string, beforeSend?: () => void): Promise<{ ok: boolean; output?: string }> {
    const agent = this.agents.get(agentId);
    if (!['start', 'stop', 'restart', 'logs'].includes(action)) return Promise.reject(new Error('Unknown process action'));
    if (!agent || !this.owns(agentId, instanceId)) return Promise.reject(new Error('Unknown managed instance'));
    if (agent.socket?.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Agent is offline; process state is unknown'));
    if (Array.from(this.pending.values()).some(p => p.agent === agent && p.instanceId === instanceId))
      return Promise.reject(new Error('An operation is already pending for this instance'));
    const requestId = randomBytes(16).toString('hex');
    return new Promise((resolve, reject) => {
      beforeSend?.();
      this.record('process-' + action, instanceId, 'Requested on ' + agentId);
      const timer = setTimeout(() => { this.pending.delete(requestId); this.record('process-timeout', instanceId, 'Operation outcome is unknown'); reject(new Error('Agent operation timed out; refresh before retrying')); }, this.commandTimeout);
      timer.unref(); this.pending.set(requestId, { agent, instanceId, timer, resolve, reject });
      agent.socket.send(JSON.stringify({ type: 'command', requestId, instanceId, action }), error => {
        if (error) { clearTimeout(timer); this.pending.delete(requestId); reject(new Error('Unable to send command to agent')); }
      });
    });
  }
  close(): void {
    clearInterval(this.heartbeat);
    this.pending.forEach(p => { clearTimeout(p.timer); p.reject(new Error('Agent service closed')); }); this.pending.clear();
    this.wss.clients.forEach(s => s.terminate()); this.wss.close(); this.agents.clear();
  }
}

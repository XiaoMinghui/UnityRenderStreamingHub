import { WebSocketSignaling } from './signaling.js';

/** Uses the same media protocol on an explicitly separate signaling endpoint. */
export class PoolSignaling extends WebSocketSignaling {
  constructor(poolId = 'default', resumeToken) {
    super(1000, '/pool');
    this.poolId = poolId;
    this.resumeToken = resumeToken;
    this.websocket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      if (message.type === 'session') {
        this.resumeToken = message.resumeToken;
        this.dispatchEvent(new CustomEvent('session', { detail: message }));
      } else if (message.type === 'resume-expired') {
        this.resumeToken = undefined;
        this.dispatchEvent(new Event('resume-expired'));
      } else if (message.type === 'assigned') {
        this.leaseId = message.leaseId;
        this.dispatchEvent(new CustomEvent('assigned', { detail: message }));
      } else if (message.type === 'queued') {
        this.dispatchEvent(new CustomEvent('queued', { detail: message }));
      } else if (message.type === 'ended') {
        this.dispatchEvent(new CustomEvent('ended', { detail: message }));
      }
    });
  }

  createConnection(connectionId) {
    this.connectionId = connectionId;
    this._send({ type: 'join', connectionId, poolId: this.poolId, resumable: true, resumeToken: this.resumeToken });
  }

  _send(message) {
    super._send(this.leaseId ? { ...message, leaseId: this.leaseId } : message);
  }

  markStreaming() {
    this._send({ type: 'streaming', connectionId: this.connectionId });
  }

  async stop() {
    this._send({ type: this.preserve && this.resumeToken ? 'suspend' : 'leave' });
    await super.stop();
  }
}

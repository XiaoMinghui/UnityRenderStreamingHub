import { WebSocketSignaling } from './signaling.js';

/** Uses the same media protocol on an explicitly separate signaling endpoint. */
export class PoolSignaling extends WebSocketSignaling {
  constructor(poolId = 'default') {
    super(1000, '/pool');
    this.poolId = poolId;
    this.websocket.addEventListener('message', event => {
      let message;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      if (message.type === 'assigned') {
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
    this._send({ type: 'join', connectionId, poolId: this.poolId });
  }

  _send(message) {
    super._send(this.leaseId ? { ...message, leaseId: this.leaseId } : message);
  }

  markStreaming() {
    this._send({ type: 'streaming', connectionId: this.connectionId });
  }

  async stop() {
    this._send({ type: 'leave' });
    await super.stop();
  }
}

import { ReceiverSession } from './receiversession.js';
import { PoolSignaling } from '/module/poolsignaling.js';

export class PoolReceiverSession extends ReceiverSession {
  constructor(player, container, config, onState = () => {}, options = {}) {
    super(player, container, config, (state, text) => {
      if (state === 'playing') this.poolSignaling?.markStreaming();
      onState(state, text);
    }, options);
    // A background waiting tab keeps its queue position and live heartbeat.
    this._visible = () => {
      if (!document.hidden && this.active && this.attempt?.assigned)
        this._retry('正在恢复视频会话', true);
    };
  }

  _createSignaling() {
    const signaling = this.poolSignaling = new PoolSignaling(this.options.poolId || 'default');
    signaling.addEventListener('ended', () => {
      if (this.poolSignaling !== signaling || !this.active) return;
      this.stop();
      this.onState('stopped', '管理员已结束本次会话，可以手动重新加入');
    });
    signaling.addEventListener('queued', ({ detail }) => {
      if (this.poolSignaling !== signaling || !this.active) return;
      this.onState('queued', `暂无空闲的 Unity sender，当前排队第 ${detail.position} 位`);
    });
    signaling.addEventListener('assigned', () => {
      if (this.poolSignaling !== signaling || !this.attempt) return;
      this.attempt.assigned = true;
      this.attempt.started = this.attempt.lastFrame = performance.now();
    });
    return signaling;
  }

  async _checkHealth(attempt) {
    // Queue waiting is independent of the video startup deadline.
    if (!attempt.assigned) return;
    return super._checkHealth(attempt);
  }
}

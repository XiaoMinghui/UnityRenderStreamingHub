import { RenderStreaming } from '/module/renderstreaming.js';
import { WebSocketSignaling } from '/module/signaling.js';

// A single owner for signaling, peer, video and input. Each retry gets a fresh
// connection ID; callbacks from an earlier attempt cannot affect its successor.
export class ReceiverSession {
  constructor(player, container, config, onState = () => {}, options = {}) {
    this.player = player;
    this.container = container;
    this.config = config;
    this.onState = onState;
    this.options = { firstFrameTimeout: 30000, frameTimeout: 8000, ...options };
    this._online = () => { if (this.active) this._retry('网络已恢复，正在重新连接', true); };
    this._visible = () => {
      if (!document.hidden && this.active) this._retry('正在恢复视频会话', true);
    };
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.failures = 0;
    window.addEventListener('online', this._online);
    document.addEventListener('visibilitychange', this._visible);
    this._connect();
  }

  stop() {
    this.active = false;
    clearTimeout(this.timer);
    window.removeEventListener('online', this._online);
    document.removeEventListener('visibilitychange', this._visible);
    this._disposeAttempt();
  }

  retry() { this._retry('正在重新连接', true); }

  async resumePlayback() {
    const attempt = this.attempt;
    if (await this.player.playVideo() && this.attempt === attempt) {
      attempt.blocked = false;
      attempt.started = attempt.lastFrame = performance.now();
      attempt.playing = false;
      this.onState('buffering', '正在恢复视频播放');
    }
  }

  _disposeAttempt() {
    const attempt = this.attempt;
    this.attempt = null;
    if (!attempt) return;
    clearInterval(attempt.monitor);
    attempt.stream.stop().catch(() => {});
    this.player.deletePlayer();
  }

  async _connect() {
    if (!this.active || this.attempt) return;
    this.onState('connecting', '正在连接信令服务器');
    this.player.createPlayer(this.container, { checked: false }, {
      autoplay: true, muted: true, fullscreenTarget: this.options.fullscreenTarget,
      onFullscreenError: this.options.onFullscreenError,
      onPlaybackError: error => {
        if (!this.attempt) return;
        if (error.name === 'NotAllowedError') {
          this.attempt.blocked = true;
          this.onState('blocked', '浏览器阻止了自动播放，请点击继续播放');
        } else this._retry('视频播放失败，请检查浏览器的视频解码支持');
      }
    });
    const signaling = this._createSignaling();
    const stream = new RenderStreaming(signaling, this.config);
    const attempt = { stream, started: performance.now(), lastFrame: performance.now(),
      lastReceived: performance.now(), frames: 0, received: 0, playing: false, polling: false };
    this.attempt = attempt;
    const current = () => this.active && this.attempt === attempt;
    const failed = reason => { if (current()) this._retry(reason); };
    signaling.addEventListener('close', () => failed('与服务器的连接已中断'));
    signaling.addEventListener('servererror', e => failed(`信令异常：${e.detail.message}`));
    stream.onDisconnect = () => failed('推流端视频或输入连接已断开');
    stream.onConnect = () => {
      if (!current()) return;
      const channel = stream.createDataChannel('input');
      this.player.setupInput(channel);
      channel.addEventListener('close', () => failed('远程操作通道已断开'));
      this.onState('waiting', '服务器已连接，等待推流端发送画面');
    };
    stream.onTrackEvent = data => {
      if (!current()) { data.track.stop(); return; }
      this.player.addTrack(data.track);
      if (data.track.kind === 'video') {
        data.track.addEventListener('ended', () => failed('视频轨道已结束'));
        if (!attempt.playing) this.onState('buffering', '已收到视频轨道，正在等待首帧');
      }
    };
    try {
      await stream.start();
      if (!current()) return;
      await stream.createConnection();
      if (!current()) return;
      attempt.monitor = setInterval(() => this._checkHealth(attempt), 1000);
    } catch (error) { failed(error.message || '无法连接服务器'); }
  }

  async _checkHealth(attempt) {
    if (this.attempt !== attempt || attempt.polling || document.hidden) return;
    attempt.polling = true;
    try {
      const stats = await attempt.stream.getStats();
      if (this.attempt !== attempt) return;
      const now = performance.now();
      let decoded = 0, received = 0;
      stats?.forEach(report => {
        if (report.type === 'inbound-rtp' && (report.kind === 'video' || report.mediaType === 'video')) {
          decoded += report.framesDecoded || 0;
          received += report.framesReceived ?? report.bytesReceived ?? 0;
        }
      });
      if (received > attempt.received) attempt.lastReceived = now;
      if (decoded > attempt.frames) {
        attempt.lastFrame = now;
        const video = this.player.videoElement;
        if (video && !video.paused && video.readyState >= 2) {
          if (!attempt.playing) this.onState('playing', '正在串流');
          attempt.playing = true;
          this.failures = 0;
        }
      }
      attempt.frames = decoded;
      attempt.received = received;
      if (!attempt.playing && !attempt.blocked && now - attempt.started > this.options.firstFrameTimeout)
        this._retry('等待视频首帧超时，请确认推流端应用已启动且网络互通');
      else if (attempt.playing && now - attempt.lastFrame > this.options.frameTimeout)
        this._retry(now - attempt.lastReceived > this.options.frameTimeout
          ? '视频数据传输中断' : '仍在接收数据，但画面停止解码');
    } catch (_) {
      if (this.attempt === attempt) this._retry('无法读取视频连接状态');
    } finally { attempt.polling = false; }
  }

  _createSignaling() { return new WebSocketSignaling(); }

  _retry(reason, immediate = false) {
    if (!this.active) return;
    if (!this.attempt && this.timer && !immediate) return;
    clearTimeout(this.timer);
    this._disposeAttempt();
    const delay = immediate ? 0 : Math.min(15000, 1000 * 2 ** Math.min(this.failures++, 4)) + Math.random() * 300;
    this.onState('retrying', `${reason}；${Math.ceil(delay / 1000)} 秒后自动重连`);
    this.timer = setTimeout(() => { this.timer = null; this._connect(); }, delay);
  }
}

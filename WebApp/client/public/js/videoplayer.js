import { Observer, Sender } from "../module/sender.js";
import { InputRemoting } from "../module/inputremoting.js";

export class VideoPlayer {
  constructor() {
    this.playerElement = null;
    this.lockMouseCheck = null;
    this.videoElement = null;
    this.fullScreenButtonElement = null;
    this.inputRemoting = null;
    this.sender = null;
    this.inputSenderChannel = null;
    this._boundFullscreen = this._onFullscreenChange.bind(this);
    this._boundMove = this._mouseMove.bind(this);
    this._boundClick = this._mouseClickFullScreen.bind(this);
  }

  /**
 * @param {Element} playerElement parent element for create video player
 * @param {HTMLInputElement} lockMouseCheck use checked propety for lock mouse 
 */
  createPlayer(playerElement, lockMouseCheck, options = {}) {
    this.options = options;
    this.playerElement = playerElement;
    this.lockMouseCheck = lockMouseCheck;

    this.videoElement = document.createElement('video');
    this.videoElement.id = 'Video';
    this.videoElement.style.touchAction = 'none';
    this.videoElement.playsInline = true;
    this.videoElement.autoplay = !!options.autoplay;
    this.videoElement.muted = !!options.muted;
    this.videoElement.setAttribute("playsinline", "");
    this.videoElement.srcObject = new MediaStream();
    this.videoElement.addEventListener('loadedmetadata', this._onLoadedVideo.bind(this), true);
    this.playerElement.appendChild(this.videoElement);

    // add fullscreen button
    this.fullScreenButtonElement = document.createElement('button');
    this.fullScreenButtonElement.type = 'button';
    this.fullScreenButtonElement.id = 'fullscreenButton';
    this.fullScreenButtonElement.setAttribute('aria-label', '进入全屏');
    this.fullScreenButtonElement.setAttribute('aria-pressed', 'false');
    this.fullScreenButtonElement.title = '进入全屏';
    this.fullScreenButtonElement.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/></svg>';
    this.fullScreenButtonElement.addEventListener('click', event => {
      event.stopPropagation();
      this._onClickFullscreenButton();
    });
    this.playerElement.appendChild(this.fullScreenButtonElement);

    document.addEventListener('webkitfullscreenchange', this._boundFullscreen);
    document.addEventListener('fullscreenchange', this._boundFullscreen);
    this.videoElement.addEventListener("click", this._mouseClick.bind(this), false);
  }

  _onLoadedVideo() {
    this.playVideo();
    this.resizeVideo();
  }

  async playVideo() {
    const video = this.videoElement;
    if (!video) return false;
    try { await video.play(); return this.videoElement === video; }
    catch (error) {
      if (this.videoElement === video && error.name !== 'AbortError') this.options.onPlaybackError?.(error);
      return false;
    }
  }

  async _onClickFullscreenButton() {
    try {
      if (document.fullscreenElement || document.webkitFullscreenElement) {
        if (document.exitFullscreen) await document.exitFullscreen();
        else await document.webkitExitFullscreen();
      } else {
        const target = this.options.fullscreenTarget || this.playerElement;
        if (target.requestFullscreen) await target.requestFullscreen();
        else if (target.webkitRequestFullscreen) await target.webkitRequestFullscreen();
        else throw new Error('当前浏览器不支持全屏，可使用浏览器的全屏模式');
      }
    } catch (error) { this.options.onFullscreenError?.(error); }
  }

  _onFullscreenChange() {
    const fullscreen = document.fullscreenElement || document.webkitFullscreenElement;
    if (!this.fullScreenButtonElement) return;
    const label = fullscreen ? '退出全屏' : '进入全屏';
    this.fullScreenButtonElement.title = label;
    this.fullScreenButtonElement.setAttribute('aria-label', label);
    this.fullScreenButtonElement.setAttribute('aria-pressed', String(!!fullscreen));
    document.removeEventListener('mousemove', this._boundMove, false);
    document.removeEventListener('click', this._boundClick, false);
    if (fullscreen && this.lockMouseCheck?.checked) {
      fullscreen.requestPointerLock?.();
      document.addEventListener('mousemove', this._boundMove, false);
      document.addEventListener('click', this._boundClick, false);
    }
    this.resizeVideo();
  }

  _mouseMove(event) {
    // Forward mouseMove event of fullscreen player directly to sender
    // This is required, as the regular mousemove event doesn't fire when in fullscreen mode
    this.sender?._onMouseEvent(event);
  }

  _mouseClick() {
    // Restores pointer lock when we unfocus the player and click on it again
    if (this.lockMouseCheck?.checked) {
      if (this.videoElement.requestPointerLock) {
        this.videoElement.requestPointerLock().catch(function () { });
      }
    }
  }

  _mouseClickFullScreen() {
    if (this.lockMouseCheck?.checked) {
      const fullscreen = document.fullscreenElement || document.webkitFullscreenElement;
      fullscreen?.requestPointerLock?.();
    }
  }

  /**
   * @param {MediaStreamTrack} track 
   */
  addTrack(track) {
    if (!this.videoElement.srcObject) {
      return;
    }

    this.videoElement.srcObject.addTrack(track);
  }

  resizeVideo() {
    if (!this.videoElement) {
      return;
    }

    const clientRect = this.videoElement.getBoundingClientRect();
    const videoRatio = this.videoWidth / this.videoHeight;
    const clientRatio = clientRect.width / clientRect.height;

    this._videoScale = videoRatio > clientRatio ? clientRect.width / this.videoWidth : clientRect.height / this.videoHeight;
    const videoOffsetX = videoRatio > clientRatio ? 0 : (clientRect.width - this.videoWidth * this._videoScale) * 0.5;
    const videoOffsetY = videoRatio > clientRatio ? (clientRect.height - this.videoHeight * this._videoScale) * 0.5 : 0;
    this._videoOriginX = clientRect.left + videoOffsetX;
    this._videoOriginY = clientRect.top + videoOffsetY;
  }

  get videoWidth() {
    return this.videoElement.videoWidth;
  }

  get videoHeight() {
    return this.videoElement.videoHeight;
  }

  get videoOriginX() {
    return this._videoOriginX;
  }

  get videoOriginY() {
    return this._videoOriginY;
  }

  get videoScale() {
    return this._videoScale;
  }

  deletePlayer() {
    document.removeEventListener("fullscreenchange", this._boundFullscreen);
    document.removeEventListener("webkitfullscreenchange", this._boundFullscreen);
    document.removeEventListener("mousemove", this._boundMove, false);
    document.removeEventListener("click", this._boundClick, false);
    if (this.inputSenderChannel) {
      this.inputSenderChannel.onopen = null;
      this.inputSenderChannel.onclose = null;
    }
    this.videoElement?.srcObject?.getTracks().forEach(track => track.stop());
    this.sender?.dispose();
    if (this.inputRemoting) {
      this.inputRemoting.stopSending();
    }
    this.inputRemoting = null;
    this.sender = null;
    this.inputSenderChannel = null;

    while (this.playerElement?.firstChild) {
      this.playerElement.removeChild(this.playerElement.firstChild);
    }

    this.playerElement = null;
    this.videoElement = null;
    this.lockMouseCheck = null;
  }

  _isTouchDevice() {
    return (('ontouchstart' in window) ||
      (navigator.maxTouchPoints > 0) ||
      (navigator.msMaxTouchPoints > 0));
  }

  /**
   * setup datachannel for player input (muouse/keyboard/touch/gamepad)
   * @param {RTCDataChannel} channel 
   */
  setupInput(channel) {
    this.sender = new Sender(this.videoElement);
    this.sender.addMouse();
    this.sender.addKeyboard();
    if (this._isTouchDevice()) {
      this.sender.addTouchscreen();
    }
    this.sender.addGamepad();
    this.inputRemoting = new InputRemoting(this.sender);

    this.inputSenderChannel = channel;
    this.inputSenderChannel.onopen = this._onOpenInputSenderChannel.bind(this);
    this.inputRemoting.subscribe(new Observer(this.inputSenderChannel));
    this.inputSenderChannel.onclose = () => this.inputRemoting?.stopSending();
    if (channel.readyState === "open") this._onOpenInputSenderChannel();
  }

  async _onOpenInputSenderChannel() {
    const channel = this.inputSenderChannel;
    await new Promise(resolve => setTimeout(resolve, 100));
    if (this.inputSenderChannel === channel && channel?.readyState === "open") this.inputRemoting?.startSending();
  }
}

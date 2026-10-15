import { getRTCConfiguration } from '../../js/config.js';
import { VideoPlayer } from '../../js/videoplayer.js';
import { ReceiverSession } from '../../js/receiversession.js';
const viewer = document.getElementById('viewer');
const overlay = document.getElementById('connectionOverlay');
const progress = document.getElementById('connectionProgress');
const retry = document.getElementById('retryButton');
const resume = document.getElementById('resumePlayback');
const titles = { connecting: '正在连接', waiting: '等待推流端画面', buffering: '正在加载画面',
  playing: '正在串流', retrying: '连接中断，正在重试', blocked: '等待播放许可', error: '暂时无法连接' };
const stages = { connecting: 20, waiting: 45, buffering: 80, playing: 100, retrying: 15 };
let session, setupTimer, setupController, generation = 0, active = true;
function showState(state, text) {
  viewer.dataset.state = state;
  overlay.hidden = state === 'playing';
  document.getElementById('liveBadge').hidden = state !== 'playing';
  document.getElementById('stateTitle').textContent = titles[state];
  document.getElementById('message').textContent = text;
  progress.hidden = state === 'error' || state === 'blocked';
  progress.value = stages[state] ?? 10;
  retry.hidden = state !== 'retrying' && state !== 'error';
  resume.hidden = state !== 'blocked';
}
async function setup() {
  session?.stop();
  session = null;
  const request = ++generation;
  clearTimeout(setupTimer);
  setupController?.abort();
  setupController = new AbortController();
  const controller = setupController;
  const timeout = setTimeout(() => controller.abort(), 10000);
  showState('connecting', '正在加载连接配置');
  try {
    const response = await fetch('/config', { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`服务器返回 ${response.status}`);
    const config = await response.json();
    if (!active || request !== generation) return;
    if (!config.useWebSocket || config.startupMode === 'private') {
      showState('error', '服务器配置不兼容，请使用 WebSocket Public 模式');
      return;
    }
    if (!window.RTCPeerConnection) {
      showState('error', '当前浏览器不支持视频串流，请使用支持 WebRTC 的浏览器');
      return;
    }
    session?.stop();
    session = new ReceiverSession(new VideoPlayer(), document.getElementById('player'), getRTCConfiguration(), showState, {
      fullscreenTarget: viewer,
      onFullscreenError: () => {
        const notice = document.getElementById('notice');
        notice.textContent = '无法进入全屏，请检查浏览器是否支持，或允许当前页面使用全屏';
        notice.hidden = false;
        setTimeout(() => { notice.hidden = true; }, 6000);
      }
    });
    session.start();
  } catch (error) {
    if (!active || request !== generation) return;
    showState('error', '无法获取连接配置，请检查服务器和网络；5 秒后自动重试');
    setupTimer = setTimeout(setup, 5000);
  } finally { clearTimeout(timeout); }
}
retry.onclick = () => session ? session.retry() : setup();
resume.onclick = () => session?.resumePlayback();
window.addEventListener('resize', () => session?.player.resizeVideo());
window.addEventListener('pagehide', () => { active = false; ++generation; clearTimeout(setupTimer); setupController?.abort(); session?.stop(); });
window.addEventListener('pageshow', event => { if (event.persisted) { active = true; setup(); } });
document.addEventListener('contextmenu', event => event.preventDefault());
setup();

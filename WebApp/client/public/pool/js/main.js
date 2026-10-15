import { getRTCConfiguration } from '../../js/config.js';
import { VideoPlayer } from '../../js/videoplayer.js';
import { PoolReceiverSession } from '../../js/poolreceiversession.js';

const viewer = document.getElementById('viewer');
const overlay = document.getElementById('connectionOverlay');
const progress = document.getElementById('connectionProgress');
const retry = document.getElementById('retryButton');
const resume = document.getElementById('resumePlayback');
const cancel = document.getElementById('cancelButton');
const titles = { connecting: '正在连接', queued: '等待空闲实例', waiting: '等待推流端画面', buffering: '正在加载画面',
  playing: '正在串流', retrying: '连接中断，正在重试', blocked: '等待播放许可', error: '暂时无法连接', stopped: '会话已停止' };
const stages = { connecting: 20, waiting: 45, buffering: 80, playing: 100, retrying: 15 };
let session, setupTimer, controller, generation = 0, active = true;
function showState(state, text) {
  viewer.dataset.state = state;
  overlay.hidden = state === 'playing';
  document.getElementById('liveBadge').hidden = state !== 'playing';
  document.getElementById('stateTitle').textContent = titles[state] || '正在连接';
  document.getElementById('message').textContent = text;
  progress.hidden = ['queued', 'stopped', 'error', 'blocked'].includes(state);
  progress.value = stages[state] ?? 10;
  retry.hidden = !['retrying', 'error', 'stopped'].includes(state);
  retry.textContent = state === 'stopped' ? '重新加入' : '立即重试';
  resume.hidden = state !== 'blocked';
  cancel.hidden = state !== 'queued';
}
async function setup() {
  session?.stop(true);
  session = null;
  const request = ++generation;
  clearTimeout(setupTimer);
  controller?.abort();
  controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  showState('connecting', '正在加载连接配置');
  try {
    const response = await fetch('/config', { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error('Configuration unavailable');
    const config = await response.json();
    if (!active || request !== generation) return;
    if (!config.poolEnabled) { showState('error', '此服务器尚未启用实例池'); return; }
    const poolId = new URLSearchParams(location.search).get('pool') || 'default';
    if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(poolId)) { showState('error', '实例池名称无效'); return; }
    if (!window.RTCPeerConnection) { showState('error', '当前浏览器不支持 WebRTC'); return; }
    session = new PoolReceiverSession(new VideoPlayer(), document.getElementById('player'), getRTCConfiguration(), showState, {
      poolId, fullscreenTarget: viewer,
      onFullscreenError: () => {
        const notice = document.getElementById('notice');
        notice.textContent = '无法进入全屏，请检查浏览器的全屏权限';
        notice.hidden = false;
        setTimeout(() => { notice.hidden = true; }, 6000);
      }
    });
    session.start();
  } catch (_) {
    if (!active || request !== generation) return;
    showState('error', '无法获取连接配置；5 秒后自动重试');
    setupTimer = setTimeout(setup, 5000);
  } finally { clearTimeout(timeout); }
}
retry.onclick = () => session ? (session.active ? session.retry() : session.start()) : setup();
cancel.onclick = () => { session?.stop(); showState('stopped', '已离开等待队列，可以重新加入'); };
resume.onclick = () => session?.resumePlayback();
window.addEventListener('resize', () => session?.player.resizeVideo());
window.addEventListener('pagehide', () => { active = false; ++generation; clearTimeout(setupTimer); controller?.abort(); session?.stop(true); });
window.addEventListener('pageshow', event => { if (event.persisted) { active = true; setup(); } });
document.addEventListener('contextmenu', event => event.preventDefault());
setup();

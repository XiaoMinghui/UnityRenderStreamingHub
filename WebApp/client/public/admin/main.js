const $ = id => document.getElementById(id);
const labels = { idle: '空闲', reserved: '连接中', busy: '使用中', resetting: '准备中', unavailable: '异常', queued: '排队中', connecting: '连接中', streaming: '串流中', stopped: '已停止', starting: '启动中', running: '运行中', stopping: '停止中', backoff: '等待重启', failed: '失败', unknown: '状态未知', unregistered: '未注册' };
let token = '', state, timer, loading = false, mutating = false, generation = 0;
const node = (tag, text, className) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; };
const duration = time => { const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000)); return seconds < 60 ? `${seconds} 秒` : seconds < 3600 ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds / 60) % 60} 分`; };
function notice(text) { $('notice').textContent = text; $('notice').hidden = !text; }
async function api(path, method = 'GET') {
  const response = await fetch(`/admin/api${path}`, { method, headers: { Authorization: `Bearer ${token}` }, cache: 'no-store', signal: AbortSignal.timeout(method === 'GET' ? 10000 : 20000) });
  const result = await response.json();
  if (response.status === 401) { logout(); throw new Error('管理凭证无效，请重新连接。'); }
  if (!response.ok) throw new Error(result.error || '请求失败');
  return result;
}
function logout() { ++generation; clearTimeout(timer); token = ''; state = null; $('dashboard').hidden = true; $('login').hidden = false; $('refresh').hidden = $('logout').hidden = true; $('connection').textContent = '未连接'; }
function confirmAction(text) {
  const dialog = $('confirmDialog'); $('confirmText').textContent = text;
  return new Promise(resolve => { dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }); dialog.showModal(); });
}
async function action(path, confirmation) {
  if (mutating) return;
  mutating = true;
  try {
    if (confirmation && !await confirmAction(confirmation)) return;
    const result = await api(path, 'POST');
    if (path.endsWith('/logs')) { $('logOutput').textContent = result.output || '暂无日志'; $('logDialog').showModal(); }
    else notice('操作已完成');
    await refresh();
  }
  catch (error) { notice(error.message); }
  finally { mutating = false; }
}
function button(text, path, confirmation) { const b = node('button', text); b.onclick = () => action(path, confirmation); return b; }
function cell(row, text) { const td = node('td', text); row.append(td); return td; }
function identity(row, title, subtitle) { const td = cell(row); td.append(node('span', title), node('small', subtitle)); }
function status(row, value, extra) { const td = cell(row); td.append(node('span', labels[value] || value, `badge ${value}`)); if (extra) td.append(node('small', extra)); }
function empty(body, columns, text) { if (!body.children.length) { const td = node('td', text, 'empty'); td.colSpan = columns; const row = node('tr'); row.append(td); body.append(row); } }
function render() {
  const selected = $('poolFilter').value;
  const pools = [...new Set([...state.instances, ...state.sessions, ...(state.agents || []).flatMap(a => a.instances)].map(s => s.poolId))].sort();
  $('poolFilter').replaceChildren(new Option('全部内容池', ''), ...pools.map(pool => new Option(pool, pool)));
  $('poolFilter').value = pools.includes(selected) ? selected : '';
  const filter = item => !$('poolFilter').value || item.poolId === $('poolFilter').value;
  $('overview').replaceChildren(...[['在线实例', state.summary.online], ['可分配', state.summary.idle], ['当前会话', state.summary.active], ['排队人数', state.summary.queued], ['异常实例', state.summary.unavailable]].map(([label, value]) => { const card = node('div', undefined, 'metric'); card.append(node('span', label), node('strong', String(value))); return card; }));
  const instances = $('instanceRows'); instances.replaceChildren();
  for (const s of state.instances.filter(filter)) {
    const row = node('tr'); row.dataset.instance = s.instanceId;
    identity(row, s.instanceId, s.poolId); status(row, s.state, s.draining ? '已停止接单' : s.lastError);
    cell(row, s.connectionId || '—'); cell(row, duration(s.connectedAt));
    const actions = node('div', undefined, 'actions'), path = `/instances/${encodeURIComponent(s.instanceId)}`;
    actions.append(button(s.draining ? '恢复接单' : '停止接单', `${path}/${s.draining ? 'resume' : 'drain'}`), button('重新准备', `${path}/reset`, `重新准备 ${s.instanceId}？当前会话将结束，准备完成后才能再次分配。`));
    cell(row).append(actions); instances.append(row);
  }
  empty(instances, 5, '暂无已注册实例。请启动 Unity sender 并连接到实例池。');
  renderAgents(filter);
  const sessions = $('sessionRows'); sessions.replaceChildren();
  for (const s of state.sessions.filter(filter)) {
    const row = node('tr'); row.dataset.session = s.connectionId;
    identity(row, s.connectionId, s.poolId); status(row, s.state, s.position ? `第 ${s.position} 位` : ''); cell(row, s.instanceId || '等待分配');
    cell(row, duration(s.assignedAt || s.joinedAt));
    cell(row).append(button(s.state === 'queued' ? '移出队列' : '结束会话', `/sessions/${encodeURIComponent(s.connectionId)}/end`, `结束 ${s.connectionId}？用户需要手动重新加入。`)); sessions.append(row);
  }
  empty(sessions, 5, '暂无会话或排队用户。');
  $('eventRows').replaceChildren(...state.events.map(event => { const li = node('li'); const time = node('time', new Date(event.at).toLocaleTimeString()); const detail = node('span', `${event.subject} · ${event.message}`); li.append(time, node('b', event.type), detail); return li; }));
  if (!state.events.length) $('eventRows').append(node('li', '暂无事件', 'muted'));
  $('updated').textContent = `更新于 ${new Date(state.at).toLocaleTimeString()}`;
}
function renderAgents(filter) {
  $('agents').hidden = $('agentNav').hidden = !state.agentsEnabled;
  if (!state.agentsEnabled) return;
  $('agentCount').textContent = `${state.agents.filter(a => a.online).length} 台在线 / ${state.agents.length} 台已登记`;
  const rows = $('agentRows'); rows.replaceChildren();
  for (const agent of state.agents) for (const instance of agent.instances.filter(filter)) {
    const row = node('tr'); row.dataset.process = instance.instanceId;
    identity(row, instance.instanceId, `${agent.agentId} · ${agent.hostname} · ${instance.poolId}`);
    status(row, agent.online ? instance.state : 'unknown', agent.online ? instance.lastError || instance.lastExit : `Agent 离线，上次报告 ${new Date(agent.lastSeen).toLocaleTimeString()}`);
    const sender = state.instances.find(s => s.instanceId === instance.instanceId && s.poolId === instance.poolId);
    status(row, sender?.state || 'unregistered', sender?.draining ? '已停止接单' : '');
    cell(row, `${instance.pid || '—'} / ${instance.restarts || 0} 次`);
    const actions = node('div', undefined, 'actions'), prefix = `/agents/${encodeURIComponent(agent.agentId)}/instances/${encodeURIComponent(instance.instanceId)}`;
    const start = button('启动', `${prefix}/start`), stop = button('停止', `${prefix}/stop`, `停止 ${instance.instanceId}？当前会话会结束，Unity 进程将退出。`), restart = button('重启', `${prefix}/restart`, `重启 ${instance.instanceId}？当前会话会结束，Unity 进程将重新启动。`), logs = button('日志', `${prefix}/logs`);
    start.disabled = !agent.online || ['running', 'starting', 'stopping'].includes(instance.state);
    stop.disabled = !agent.online || ['stopped', 'stopping'].includes(instance.state);
    restart.disabled = !agent.online || ['starting', 'stopping'].includes(instance.state); logs.disabled = !agent.online;
    actions.append(start, stop, restart, logs); cell(row).append(actions); rows.append(row);
  }
  empty(rows, 5, '暂无进程管理 Agent。请在渲染机器上配置并启动 Agent。');
}
async function refresh() {
  if (!token || loading) return;
  loading = true; clearTimeout(timer); const request = generation;
  try {
    const result = await api('/state'); if (request !== generation) return;
    state = result; render(); $('login').hidden = true; $('dashboard').hidden = false; $('refresh').hidden = $('logout').hidden = false;
    $('connection').textContent = '已连接 · 每 3 秒更新';
  } catch (error) { if (request === generation || !token) { notice(error.message); $('connection').textContent = token ? '连接中断 · 正在重试' : '未连接'; } }
  finally { loading = false; if (token) timer = setTimeout(refresh, 3000); }
}
$('loginForm').onsubmit = event => { event.preventDefault(); if (loading) return; token = $('credential').value.trim(); $('credential').value = ''; ++generation; notice(''); refresh(); };
$('logout').onclick = () => { logout(); notice(''); };
$('refresh').onclick = refresh;
$('poolFilter').onchange = () => { if (state) render(); };
window.addEventListener('pagehide', logout);

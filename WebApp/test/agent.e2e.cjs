const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { chromium } = require('playwright');
const { createServer: createApp } = require('../build/server');
const WSSignaling = require('../build/websocket').default;
const { loadConfig, ProcessManager } = require('../../Tools/ProcessAgent/process-manager.cjs');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await condition()) return; await wait(30); }
  throw new Error('Condition timed out');
}
async function run() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'renderstreaming-agent-'));
  const app = createApp({ type: 'websocket', mode: 'public', logging: 'none', pool: true, admin: true, agents: true,
    poolToken: 'fixture-sender-secret', adminToken: 'fixture-admin-secret', agentToken: 'fixture-agent-secret' });
  const server = createServer(app), signaling = new WSSignaling(server, 'public', 20000, 3, { senderToken: 'fixture-sender-secret' }, 'fixture-agent-secret');
  app.locals.pool = signaling.pool; app.locals.agents = signaling.agents;
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const definition = { poolId: 'default', executable: process.execPath, autoRestart: true, restartDelayMs: 100, maxRestarts: 2 };
  const fixture = path.join(__dirname, 'fixtures/managed-sender.cjs');
  const configPath = path.join(directory, 'agent.json');
  const config = { agentId: 'test-machine', serverUrl: base.replace('http:', 'ws:') + '/agent', maxProcesses: 2, reconnectDelayMs: 500,
    instances: [
      { ...definition, instanceId: 'sender-01', args: [fixture, '--exit-once', path.join(directory, 'once'), 'literal; argument'], autoStart: true },
      { ...definition, instanceId: 'sender-02', args: [fixture, '--child'], autoStart: true },
      { ...definition, instanceId: 'sender-03', args: [fixture, '--never-register'] }
    ] };
  fs.writeFileSync(configPath, JSON.stringify(config));
  const agent = spawn(process.execPath, [path.join(__dirname, 'fixtures/agent-runner.cjs'), configPath], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env,
      RENDERSTREAMING_POOL_TOKEN: 'fixture-sender-secret', RENDERSTREAMING_AGENT_TOKEN: 'fixture-agent-secret', RENDERSTREAMING_ADMIN_TOKEN: 'fixture-admin-secret' }
  });
  let browser;
  const state = () => ({ ...signaling.pool.snapshot(), agents: signaling.agents.snapshot() });
  const managed = id => state().agents[0]?.instances.find(i => i.instanceId === id);
  async function api(id, action) {
    return fetch(`${base}/admin/api/agents/test-machine/instances/${id}/${action}`, { method: 'POST', headers: { Authorization: 'Bearer fixture-admin-secret' } });
  }
  try {
    await until(() => state().summary.idle === 2 && managed('sender-01')?.restarts === 1);
    assert.equal((await api('sender-03', 'start')).status, 409, 'process limit must reject extra launches');
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) });
    const page = await browser.newPage({ viewport: { width: 1500, height: 1100 } }), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + '/admin/'); await page.locator('#credential').fill('fixture-admin-secret');
    await page.getByRole('button', { name: '连接', exact: true }).click();
    await page.locator('#agents').waitFor({ state: 'visible' });
    const row = id => page.locator(`[data-process="${id}"]`);
    await row('sender-02').getByRole('button', { name: '日志', exact: true }).click();
    await page.locator('#logDialog').waitFor({ state: 'visible' });
    const logs = await page.locator('#logOutput').innerText();
    assert.ok(!logs.includes('fixture-sender-secret')); assert.match(logs, /\[redacted\]/);
    assert.match(logs, /adminInherited=false;agentInherited=false/);
    const descendant = Number(/descendant=(\d+)/.exec(logs)[1]);
    await page.locator('#logDialog button').click();
    const previousPid = managed('sender-02').pid;
    await row('sender-02').getByRole('button', { name: '重启', exact: true }).click();
    await page.locator('#confirmDialog button[value="confirm"]').click();
    await until(() => managed('sender-02').pid && managed('sender-02').pid !== previousPid && state().summary.idle === 2);
    assert.throws(() => process.kill(descendant, 0), 'stopping the managed process also stops its descendant');
    const beforeReconnect = managed('sender-01').pid;
    signaling.agents.wss.clients.forEach(s => s.terminate());
    await until(() => state().agents[0].online === false);
    assert.equal((await api('sender-01', 'stop')).status, 409);
    assert.equal(signaling.pool.isDraining('sender-01'), false, 'offline commands must have no pool side effects');
    await until(() => state().agents[0].online === true);
    await until(() => managed('sender-01').pid === beforeReconnect);
    await fetch(`${base}/admin/api/instances/sender-01/drain`, { method: 'POST', headers: { Authorization: 'Bearer fixture-admin-secret' } });
    const receiver = await browser.newPage(); await receiver.goto(base + '/pool/');
    await until(() => state().sessions.some(s => s.instanceId === 'sender-02'));
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await row('sender-02').getByRole('button', { name: '停止', exact: true }).click(); await page.locator('#confirmDialog button[value="confirm"]').click();
    await until(() => managed('sender-02').state === 'stopped' && state().summary.online === 1);
    await receiver.waitForFunction(() => viewer.dataset.state === 'stopped');
    assert.equal(state().sessions.length, 0, 'process Stop ends the lease before terminating Unity');
    await fetch(`${base}/admin/api/instances/sender-01/resume`, { method: 'POST', headers: { Authorization: 'Bearer fixture-admin-secret' } });
    await row('sender-03').getByRole('button', { name: '启动', exact: true }).click();
    await until(() => managed('sender-03').state === 'running');
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    assert.match(await row('sender-03').innerText(), /未注册/);
    assert.equal(state().summary.online, 1, 'running process without signaling is not available');
    if (process.env.AGENT_SCREENSHOT) await page.screenshot({ path: process.env.AGENT_SCREENSHOT, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    // Validate bounded crash loops independently using an executable that always exits.
    const crashConfigPath = path.join(directory, 'crash.json');
    fs.writeFileSync(crashConfigPath, JSON.stringify({ ...config, logDirectory: 'crash-logs', maxProcesses: 1,
      instances: [{ ...definition, instanceId: 'crash', args: ['-e', 'process.exit(3)'] }] }));
    const manager = new ProcessManager(loadConfig(crashConfigPath), 'fixture-sender-secret');
    await manager.operate('crash', 'start'); await until(() => manager.snapshot()[0].state === 'failed');
    assert.equal(manager.snapshot()[0].restarts, 2); await manager.close();
    fs.writeFileSync(crashConfigPath, JSON.stringify({ ...config, instances: [config.instances[0], config.instances[0]] }));
    assert.throws(() => loadConfig(crashConfigPath), /unique/);
    console.log('PASS Process agents: real child processes, multi-instance readiness, crash/retry limits, process-tree stop/restart, reconnect without duplicates, capacity limits, redacted logs and dashboard controls.');
  } finally {
    await browser?.close();
    const ownedPids = (state().agents[0]?.instances || []).map(i => i.pid).filter(Boolean);
    if (agent.exitCode === null) {
      const exited = once(agent, 'exit'); if (agent.connected) agent.send('shutdown');
      let timeout;
      try { await Promise.race([exited, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Agent did not shut down gracefully')), 12000); })]); }
      finally { clearTimeout(timeout); }
    }
    signaling.close(); await new Promise(resolve => server.close(resolve));
    for (const pid of ownedPids) assert.throws(() => process.kill(pid, 0), 'agent shutdown stops all owned processes');
    // Generated configs/logs stay in the OS temporary directory, outside the repository.
    assert.equal(fs.existsSync(path.join(directory, 'logs/.agent.lock')), false);
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });

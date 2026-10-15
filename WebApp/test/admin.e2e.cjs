const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const net = require('node:net');
const WebSocket = require('ws');
const { chromium } = require('playwright');

async function run() {
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['build/index.js', '-p', String(port), '--pool', '--admin', '-l', 'none'], {
    cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: 'pipe',
    env: { ...process.env, RENDERSTREAMING_POOL_TOKEN: 'sender-test', RENDERSTREAMING_ADMIN_TOKEN: 'admin-test' }
  });
  let browser, sender;
  try {
    await Promise.race([once(server.stdout, 'data'), once(server, 'exit').then(() => { throw new Error('Server exited'); })]);
    browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }) });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.goto(base + '/admin/');
    await page.locator('#credential').fill('wrong'); await page.getByRole('button', { name: '连接', exact: true }).click();
    await page.waitForFunction(() => notice.textContent.includes('凭证无效'));
    await page.locator('#credential').fill('admin-test'); await page.getByRole('button', { name: '连接', exact: true }).click();
    await page.locator('#dashboard').waitFor({ state: 'visible' });
    assert.match(await page.locator('#instanceRows').innerText(), /暂无/);
    sender = new WebSocket(base.replace('http:', 'ws:') + '/pool');
    sender.on('message', data => { const m = JSON.parse(String(data)); if (m.type === 'reset') sender.send(JSON.stringify({ type: 'ready', resetId: m.resetId })); });
    await once(sender, 'open'); sender.send(JSON.stringify({ type: 'register', instanceId: 'sender-01', poolId: 'default', token: 'sender-test' }));
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    const row = page.locator('[data-instance="sender-01"]'); await row.waitFor();
    await row.getByRole('button', { name: '停止接单', exact: true }).click();
    await page.waitForFunction(() => instanceRows.textContent.includes('已停止接单'));
    const receiver = await browser.newPage(); await receiver.goto(base + '/pool/');
    await receiver.waitForFunction(() => viewer.dataset.state === 'queued');
    await page.getByRole('button', { name: '刷新', exact: true }).click();
    await page.getByRole('button', { name: '移出队列', exact: true }).click();
    await page.locator('#confirmDialog button[value="confirm"]').click();
    await receiver.waitForFunction(() => viewer.dataset.state === 'stopped');
    await receiver.waitForTimeout(1700); assert.equal(await receiver.evaluate(() => viewer.dataset.state), 'stopped');
    await page.getByRole('button', { name: '恢复接单', exact: true }).click();
    await page.waitForFunction(() => !instanceRows.textContent.includes('已停止接单'));
    if (process.env.ADMIN_SCREENSHOT) await page.screenshot({ path: process.env.ADMIN_SCREENSHOT, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
    await page.getByRole('button', { name: '退出', exact: true }).click(); await page.locator('#login').waitFor({ state: 'visible' });
    assert.deepEqual(errors, []);
    console.log('PASS Management dashboard: auth, empty/live states, drain/resume, queue removal without automatic rejoin, responsive layout and logout.');
  } finally {
    sender?.terminate(); await browser?.close();
    if (server.exitCode === null) { const exited = once(server, 'exit'); server.kill(); await exited; }
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });

// Real media and input isolation with two synthetic senders and three receivers.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const path = require('node:path');
const { chromium } = require('playwright');

async function run() {
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['build/index.js', '-p', String(port), '-t', 'websocket', '-m', 'public', '--pool', '--pool-resume-seconds', '5', '--admin', '-l', 'none'], {
    cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: 'pipe',
    env: { ...process.env, RENDERSTREAMING_POOL_TOKEN: 'synthetic-test-token', RENDERSTREAMING_ADMIN_TOKEN: 'synthetic-admin-token' }
  });
  server.stderr.on('data', data => process.stderr.write(data));
  let browser;
  try {
    await Promise.race([once(server.stdout, 'data'), once(server, 'exit').then(([code]) => { throw new Error(`Server exited: ${code}`); })]);
    browser = await chromium.launch({
      headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
      args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']
    });
    const errors = [];
    browser.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    async function sender(instanceId, color) {
      const page = await browser.newPage();
      await page.goto(base);
      await page.evaluate(async ({ instanceId, color }) => {
        const { default: Peer } = await import('/module/peer.js');
        const canvas = document.createElement('canvas');
        canvas.width = 640; canvas.height = 360; document.body.append(canvas);
        const context = canvas.getContext('2d');
        let frame = 0;
        setInterval(() => { context.fillStyle = color; context.fillRect(0, 0, 640, 360); context.fillStyle = 'white'; context.fillText(String(frame++), 10, 20); }, 40);
        const track = canvas.captureStream(25).getVideoTracks()[0];
        const socket = window.senderSocket = new WebSocket(`${location.origin.replace('http', 'ws')}/pool`);
        window.inputs = 0; window.assignments = []; window.resets = 0;
        let assignment, peer;
        const send = message => socket.send(JSON.stringify({ ...message, leaseId: assignment?.leaseId }));
        socket.onopen = () => send({ type: 'register', instanceId, poolId: 'default', token: 'synthetic-test-token' });
        socket.onmessage = async event => {
          const message = JSON.parse(event.data);
          if (message.type === 'reset') {
            window.resets++;
            peer?.close(); peer = null; assignment = null;
            send({ type: 'ready', resetId: message.resetId });
            window.ready = true;
          } else if (message.type === 'assigned') {
            assignment = message;
            assignments.push(message.connectionId);
          } else if (message.type === 'offer') {
            if (!peer) {
              peer = new Peer(message.from, message.data.polite, { iceServers: [] });
              peer.addEventListener('sendoffer', e => send({ type: 'offer', data: e.detail }));
              peer.addEventListener('sendanswer', e => send({ type: 'answer', data: e.detail }));
              peer.addEventListener('sendcandidate', e => send({ type: 'candidate', data: e.detail }));
              peer.addEventListener('adddatachannel', e => { e.detail.channel.onmessage = () => window.inputs++; });
              peer.addTrack(message.from, track);
            }
            await peer.onGotDescription(message.from, { type: 'offer', sdp: message.data.sdp });
          } else if (message.type === 'answer') {
            await peer?.onGotDescription(message.from, { type: 'answer', sdp: message.data.sdp });
          } else if (message.type === 'candidate') {
            await peer?.onGotCandidate(message.from, new RTCIceCandidate(message.data));
          } else if (message.type === 'disconnect') { peer?.close(); peer = null; }
          else if (message.type === 'error') throw new Error(message.message);
        };
      }, { instanceId, color });
      await page.waitForFunction(() => window.ready);
      return page;
    }
    const a = await sender('sender-a', 'red'), b = await sender('sender-b', 'blue');
    const receiver = async () => {
      const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
      await page.addInitScript(() => {
        window.sockets = [];
        const Native = window.WebSocket;
        window.WebSocket = class extends Native { constructor(...args) { super(...args); sockets.push(this); } };
      });
      await page.goto(`${base}/pool/index.html`);
      return page;
    };
    const playing = page => page.waitForFunction(() => viewer.dataset.state === 'playing' && Video.videoWidth > 0 && !Video.paused);
    const r1 = await receiver(); await playing(r1);
    const r2 = await receiver(); await playing(r2);
    const r3 = await receiver(); await r3.waitForFunction(() => viewer.dataset.state === 'queued');
    assert.match(await r3.locator('#message').textContent(), /第 1 位/);
    assert.equal(await a.evaluate(() => assignments.length), 1);
    assert.equal(await b.evaluate(() => assignments.length), 1);
    // Compare actual decoded colors, not just signaling metadata.
    async function pixel(page) {
      return page.evaluate(() => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d'); context.drawImage(Video, 0, 0, 1, 1);
        return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
      });
    }
    const p1 = await pixel(r1), p2 = await pixel(r2);
    assert.ok(p1[0] > 180 && p1[2] < 60, `First user should receive red, got ${p1}`);
    assert.ok(p2[2] > 180 && p2[0] < 60, `Second user should receive blue, got ${p2}`);
    const beforeB = await b.evaluate(() => inputs);
    await r1.mouse.click(400, 200);
    await a.waitForFunction(() => inputs > 5);
    assert.equal(await b.evaluate(() => inputs), beforeB, 'input must stay in the assigned instance');
    // A socket outage and a full page refresh retain the same app, without reset.
    const originalResets = await a.evaluate(() => resets);
    const originalPixel = await pixel(r1);
    const adminState = async () => (await fetch(`${base}/admin/api/state`, { headers: { Authorization: 'Bearer synthetic-admin-token' } })).json();
    const originalJoinedAt = (await adminState()).sessions.find(s => s.instanceId === 'sender-a').joinedAt;
    await r1.context().setOffline(true); await r1.evaluate(() => sockets.at(-1).close());
    await r1.waitForTimeout(300);
    assert.equal((await adminState()).sessions.find(s => s.instanceId === 'sender-a').state, 'reconnecting');
    await r1.context().setOffline(false); await playing(r1);
    assert.deepEqual(await pixel(r1), originalPixel, 'same sender after outage');
    assert.equal(await a.evaluate(() => resets), originalResets);
    const inputAfterRecovery = await a.evaluate(() => inputs); await r1.mouse.click(350, 180);
    await a.waitForFunction(before => inputs > before, inputAfterRecovery);
    await r1.reload(); await playing(r1);
    assert.deepEqual(await pixel(r1), originalPixel, 'same sender after refresh');
    assert.equal(await a.evaluate(() => resets), originalResets);
    assert.equal((await adminState()).sessions.find(s => s.instanceId === 'sender-a').joinedAt, originalJoinedAt);
    const queueJoinedAt = (await adminState()).sessions.find(s => s.state === 'queued').joinedAt;
    await r3.reload(); await r3.waitForFunction(() => viewer.dataset.state === 'queued');
    assert.equal((await adminState()).sessions.find(s => s.state === 'queued').joinedAt, queueJoinedAt);
    // Keep the real queue alive beyond the legacy 30-second first-frame deadline.
    await r3.waitForTimeout(31000);
    assert.equal(await r3.evaluate(() => viewer.dataset.state), 'queued');
    assert.equal(await r3.evaluate(() => sockets.length), 1, 'queue waiting must not trigger reconnect');
    await r3.locator('#cancelButton').click();
    await r3.waitForFunction(() => viewer.dataset.state === 'stopped');
    await r3.locator('#retryButton').click();
    await r3.waitForFunction(() => viewer.dataset.state === 'queued');
    const assignmentsBeforeRelease = await a.evaluate(() => assignments.length);
    await r1.close();
    await playing(r3);
    assert.equal(await a.evaluate(() => assignments.length), assignmentsBeforeRelease + 1);
    assert.equal(await r2.evaluate(() => viewer.dataset.state), 'playing');
    // Dropped signaling recovers the existing instance and one live browser socket.
    const socketsBeforeRecovery = await r3.evaluate(() => sockets.length);
    const resetsBeforeRecovery = await a.evaluate(() => resets);
    await r3.evaluate(() => sockets.at(-1).close());
    await r3.waitForFunction(count => sockets.length === count + 1 && viewer.dataset.state === 'playing', socketsBeforeRecovery);
    assert.equal(await r3.evaluate(() => sockets.filter(socket => socket.readyState === 1).length), 1);
    assert.equal(await a.evaluate(() => resets), resetsBeforeRecovery);
    // Outage longer than grace releases capacity and the old tab joins again.
    await r3.context().setOffline(true); await r3.evaluate(() => sockets.at(-1).close());
    const r4 = await receiver(); await playing(r4);
    assert.equal(await a.evaluate(() => resets), resetsBeforeRecovery + 1);
    await r3.context().setOffline(false); await r3.waitForFunction(() => viewer.dataset.state === 'queued');
    assert.equal((await adminState()).summary.active, 2);
    assert.match(await r3.locator('#message').textContent(), /第 1 位/);
    assert.deepEqual(errors, [], 'browser exceptions');
    console.log('PASS Pool: independent video/input, queue >30s, same-instance outage/refresh recovery without reset, preserved queue order, one live socket, grace expiry/reset/reallocation and expired-token requeue.');
  } finally {
    await browser?.close();
    if (server.exitCode === null) { const exited = once(server, 'exit'); server.kill(); await exited; }
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });

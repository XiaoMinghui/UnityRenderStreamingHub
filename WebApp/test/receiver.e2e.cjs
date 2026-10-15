// Real Chromium + WebSocket + WebRTC tests. No Unity or Android build required.
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
  const server = spawn(process.execPath, ['build/index.js', '-p', String(port), '-t', 'websocket', '-m', 'public', '-l', 'none'], {
    cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: 'pipe'
  });
  server.stderr.on('data', data => process.stderr.write(data));
  let browser;
  try {
    await Promise.race([
      once(server.stdout, 'data'),
      once(server, 'exit').then(([code]) => { throw new Error(`Test server exited: ${code}`); })
    ]);
    browser = await chromium.launch({
      headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
      args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']
    });
    const errors = [];
    const source = await browser.newPage();
    source.on('pageerror', error => errors.push(error.message));
    source.on('console', message => { if (message.type() === 'error') console.error('Source browser:', message.text()); });
    // Keep a real same-origin navigation: fulfilling the document synthetically
    // makes recent Chromium treat its IP address space as unknown.
    await source.goto(`${base}/`);
    await source.evaluate(async () => {
      const { WebSocketSignaling } = await import('/module/signaling.js');
      const { default: Peer } = await import('/module/peer.js');
      const canvas = document.createElement('canvas');
      canvas.width = 1280; canvas.height = 720; document.body.appendChild(canvas);
      const context = canvas.getContext('2d');
      let frame = 0;
      setInterval(() => { context.fillStyle = `hsl(${frame++ % 360} 60% 35%)`; context.fillRect(0, 0, 1280, 720); }, 40);
      window.testTrack = canvas.captureStream(25).getVideoTracks()[0];
      window.messages = 0;
      const signaling = new WebSocketSignaling();
      window.sourceSignaling = signaling;
      signaling.addEventListener('offer', async ({ detail }) => {
        if (window.sourcePeer?.connectionId !== detail.connectionId) {
          window.sourcePeer?.close();
          const peer = window.sourcePeer = new Peer(detail.connectionId, detail.polite, { iceServers: [] });
          peer.addEventListener('sendoffer', e => signaling.sendOffer(e.detail.connectionId, e.detail.sdp));
          peer.addEventListener('sendanswer', e => signaling.sendAnswer(e.detail.connectionId, e.detail.sdp));
          peer.addEventListener('sendcandidate', e => signaling.sendCandidate(e.detail.connectionId, e.detail.candidate, e.detail.sdpMLineIndex, e.detail.sdpMid));
          peer.addEventListener('adddatachannel', e => {
            window.inputChannel = e.detail.channel;
            e.detail.channel.onmessage = () => window.messages++;
          });
          if (window.enableVideo) peer.addTrack(detail.connectionId, testTrack);
        }
        await sourcePeer.onGotDescription(detail.connectionId, { type: 'offer', sdp: detail.sdp });
      });
      signaling.addEventListener('answer', e => sourcePeer?.onGotDescription(e.detail.connectionId, { type: 'answer', sdp: e.detail.sdp }));
      signaling.addEventListener('candidate', e => sourcePeer?.onGotCandidate(e.detail.connectionId, new RTCIceCandidate(e.detail)));
      await signaling.start();
    });
    let page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      window.sockets = [];
      const Native = window.WebSocket;
      window.WebSocket = class extends Native { constructor(...args) { super(...args); sockets.push(this); } };
    });
    await page.goto(`${base}/receiver/index.html`);
    await source.waitForFunction(() => window.inputChannel?.readyState === 'open');
    assert.equal(await page.locator('#connectionOverlay').isVisible(), true, 'signaling/input alone must not hide loading');
    await source.evaluate(() => { window.enableVideo = true; sourcePeer.addTrack(sourcePeer.connectionId, testTrack); });
    const playing = () => page.waitForFunction(() => viewer.dataset.state === 'playing' && !Video.paused && Video.videoWidth > 0);
    await playing();
    // Chromium may adapt the synthetic source resolution under CPU load.
    assert.deepEqual(await page.evaluate(() => [Video.videoWidth / Video.videoHeight, Video.autoplay, Video.muted]), [16 / 9, true, true]);
    assert.equal(await page.locator('#connectionOverlay').isVisible(), false);
    assert.equal(await page.locator('#playButton').count(), 0);
    assert.equal(await page.locator('video').evaluate(video => getComputedStyle(video).objectFit), 'contain');
    assert.deepEqual(await page.locator('video').evaluate(video => [video.clientWidth, video.clientHeight]), [1200, 800]);
    await page.locator('#fullscreenButton').click();
    await page.waitForFunction(() => document.fullscreenElement?.id === 'viewer');
    await page.locator('#fullscreenButton').click();
    await page.waitForFunction(() => !document.fullscreenElement);
    await page.setViewportSize({ width: 800, height: 1280 });
    assert.deepEqual(await page.evaluate(async () => {
      const { PointerCorrector } = await import('/module/pointercorrect.js');
      return new PointerCorrector(1280, 720, Video).map([400, 640]);
    }), [640, 360], 'letterbox pointer mapping must match the video');
    for (let retry = 0; retry < 3; retry++) {
      await page.evaluate(() => sockets.at(-1).close());
      await page.waitForFunction(count => sockets.length > count && viewer.dataset.state === 'playing', retry + 1);
      assert.equal(await page.evaluate(() => sockets.filter(socket => socket.readyState === 1).length), 1);
    }
    await page.mouse.click(400, 640);
    await source.waitForFunction(() => messages > 5);

    // Inject a frozen inbound stats sample while keeping real media available
    // for the replacement session. Exercise both diagnostic/recovery branches.
    await page.evaluate(async () => {
      const { ReceiverSession } = await import('/js/receiversession.js');
      const check = ReceiverSession.prototype._checkHealth;
      ReceiverSession.prototype._checkHealth = function(attempt) {
        window.session = this; window.attempt = attempt;
        return check.call(this, attempt);
      };
    });
    await page.waitForFunction(() => window.attempt?.playing);
    for (const receivedProgress of [true, false]) {
      await page.evaluate(async progress => {
        const current = attempt;
        current.lastFrame = current.lastReceived = performance.now() - 10000;
        current.stream.getStats = async () => new Map([['video', { type: 'inbound-rtp', kind: 'video', framesDecoded: current.frames, framesReceived: current.received + Number(progress) }]]);
        await session._checkHealth(current);
      }, receivedProgress);
      assert.match(await page.locator('#message').textContent(), receivedProgress ? /停止解码/ : /数据传输中断/);
      await playing();
    }
    await page.close();

    // Simulate a browser policy denying even muted autoplay. Recovery uses an
    // explicit exception button, without adding a play step to the normal flow.
    page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      const original = HTMLMediaElement.prototype.play;
      Object.defineProperty(HTMLMediaElement.prototype, 'autoplay', { set() {}, get() { return false; } });
      HTMLMediaElement.prototype.play = function() {
        return window.allowPlayback ? original.call(this) : Promise.reject(new DOMException('Policy test', 'NotAllowedError'));
      };
    });
    await page.goto(`${base}/receiver/index.html`);
    await page.waitForFunction(() => viewer.dataset.state === 'blocked');
    assert.equal(await page.locator('#connectionOverlay').isVisible(), true);
    await page.evaluate(() => { window.allowPlayback = true; });
    await page.locator('#resumePlayback').click();
    await playing();
    await page.close();

    page = await browser.newPage();
    let failConfig = true;
    await page.route('**/config', route => failConfig ? route.fulfill({ status: 503, body: 'Unavailable' }) : route.continue());
    await page.goto(`${base}/receiver/index.html`);
    await page.waitForFunction(() => viewer.dataset.state === 'error');
    assert.match(await page.locator('#message').textContent(), /服务器和网络/);
    failConfig = false;
    await page.locator('#retryButton').click();
    await playing();
    assert.deepEqual(errors, [], 'browser exceptions');
    console.log('PASS Receiver: loading/first frame, autoplay, contain/portrait mapping, fullscreen, 3 reconnects, input, 2 freeze recoveries, autoplay denial recovery, config failure recovery.');
  } finally {
    await browser?.close();
    if (server.exitCode === null) {
      const exited = once(server, 'exit');
      server.kill();
      await exited;
    }
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });

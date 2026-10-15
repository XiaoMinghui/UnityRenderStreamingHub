'use strict';
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig, ProcessManager } = require('./process-manager.cjs');

async function run(filename) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Process agent requires Node.js 22 or newer');
  const config = loadConfig(filename);
  const token = process.env.RENDERSTREAMING_AGENT_TOKEN, senderToken = process.env.RENDERSTREAMING_POOL_TOKEN;
  if (!token || !senderToken || token === senderToken) throw new Error('Set different RENDERSTREAMING_AGENT_TOKEN and RENDERSTREAMING_POOL_TOKEN credentials');
  const lockfile = path.join(config.logDirectory, '.agent.lock'); fs.mkdirSync(config.logDirectory, { recursive: true });
  let lock;
  try { lock = fs.openSync(lockfile, 'wx'); }
  catch (_) { throw new Error('Agent log directory is locked. Stop the existing agent; inspect orphan processes before removing a stale .agent.lock.'); }
  fs.writeSync(lock, String(process.pid));
  const manager = new ProcessManager(config, senderToken);
  let socket, registeredSocket, retry, registration, monitor, shutdown = false, autostarted = false, reconnects = 0;
  const send = value => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
  const report = () => { if (registeredSocket === socket) send({ type: 'status', instances: manager.snapshot() }); };
  manager.on('status', report);
  async function close() {
    if (shutdown) return; shutdown = true; clearTimeout(retry); clearTimeout(registration); clearInterval(monitor);
    socket?.close();
    try { await manager.close(); fs.closeSync(lock); fs.unlinkSync(lockfile); }
    catch (_) { console.error('Unable to stop every managed process; lock retained for inspection.'); process.exitCode = 1; }
  }
  process.once('SIGINT', close); process.once('SIGTERM', close);
  function connect() {
    if (shutdown) return;
    const current = socket = new WebSocket(config.serverUrl); let registered = false, lastStatus = Date.now();
    registration = setTimeout(() => current.close(), 10000);
    current.addEventListener('open', () => send({ type: 'register', token, agentId: config.agentId,
      hostname: os.hostname(), instances: config.instances.map(i => ({ instanceId: i.instanceId, poolId: i.poolId })) }));
    current.addEventListener('error', () => {});
    current.addEventListener('message', async event => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === 'registered') {
          registered = true; registeredSocket = current; reconnects = 0; clearTimeout(registration); report();
          console.log(`Agent ${config.agentId} connected; ${config.instances.length} configured instances.`);
          monitor = setInterval(() => {
            if (Date.now() - lastStatus > 45000) { current.close(); return; }
            report(); send({ type: 'ping' });
          }, 2000);
          if (!autostarted) {
            autostarted = true;
            for (const instance of config.instances.filter(i => i.autoStart)) {
              if (shutdown) break;
              await manager.operate(instance.instanceId, 'start').catch(() => console.error('An auto-start instance failed; inspect status and local logs.'));
            }
          }
        } else if (message.type === 'pong') lastStatus = Date.now();
        else if (message.type === 'command' && registered) {
          if (!/^[a-f0-9]{32}$/.test(message.requestId)) return;
          try {
            const output = await manager.operate(message.instanceId, message.action);
            if (socket === current && current.readyState === WebSocket.OPEN) {
              report(); send({ type: 'result', requestId: message.requestId, ok: true, output });
            }
          } catch (_) {
            if (socket === current && current.readyState === WebSocket.OPEN) { report(); send({ type: 'result', requestId: message.requestId, ok: false }); }
          }
        }
      } catch (_) { current.close(); }
    });
    current.addEventListener('close', () => {
      if (registeredSocket === current) registeredSocket = null;
      clearTimeout(registration); clearInterval(monitor);
      if (!shutdown) {
        console.warn('Agent connection lost or rejected; retrying. Managed processes keep their current state.');
        retry = setTimeout(connect, Math.min(30000, config.reconnectDelayMs * Math.pow(2, Math.min(reconnects++, 4))));
      }
    });
  }
  connect();
  return { close, manager };
}
if (require.main === module) {
  const index = process.argv.indexOf('--config');
  if (index < 0 || !process.argv[index + 1]) { console.error('Usage: node agent.cjs --config <agent.json>'); process.exitCode = 1; }
  else run(process.argv[index + 1]).catch(error => {
    const reason = error instanceof SyntaxError ? 'Invalid JSON in the Agent config.' : error.code ? `Filesystem error ${error.code}; check config and executable paths.` : error.message;
    console.error('Agent startup failed: ' + reason); process.exitCode = 1;
  });
}
module.exports = { run };

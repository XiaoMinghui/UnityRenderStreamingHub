// A real child process for supervisor tests. It supplies signaling, not Unity media.
const fs = require('node:fs');
const WebSocket = require('ws');
const { spawn } = require('node:child_process');
const index = process.argv.indexOf('--exit-once');
if (index >= 0 && !fs.existsSync(process.argv[index + 1])) {
  fs.writeFileSync(process.argv[index + 1], 'first launch'); process.exit(7);
}
console.log(`Fixture ${process.env.RENDERSTREAMING_INSTANCE_ID}; secret=${process.env.RENDERSTREAMING_POOL_TOKEN}`);
console.log(`adminInherited=${!!process.env.RENDERSTREAMING_ADMIN_TOKEN};agentInherited=${!!process.env.RENDERSTREAMING_AGENT_TOKEN}`);
console.log('Arguments:', JSON.stringify(process.argv.slice(2)));
if (process.argv.includes('--child')) {
  const descendant = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true });
  console.log('descendant=' + descendant.pid);
}
const heartbeat = setInterval(() => {}, 1000);
if (!process.argv.includes('--never-register')) {
  const socket = new WebSocket(process.env.RENDERSTREAMING_SIGNALING_URL);
  socket.on('open', () => socket.send(JSON.stringify({ type: 'register', instanceId: process.env.RENDERSTREAMING_INSTANCE_ID,
    poolId: process.env.RENDERSTREAMING_POOL_ID, token: process.env.RENDERSTREAMING_POOL_TOKEN })));
  socket.on('message', raw => { const m = JSON.parse(String(raw)); if (m.type === 'reset') socket.send(JSON.stringify({ type: 'ready', resetId: m.resetId })); });
  socket.on('error', () => {});
  socket.on('close', () => { clearInterval(heartbeat); process.exit(0); });
}

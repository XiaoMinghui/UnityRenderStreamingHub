// IPC is used only by tests to request graceful shutdown on Windows.
const { run } = require('../../../Tools/ProcessAgent/agent.cjs');
run(process.argv[2]).then(agent => {
  process.on('message', async message => {
    if (message !== 'shutdown') return;
    await agent.close(); if (process.connected) process.disconnect();
  });
  if (process.connected) process.send('ready');
}).catch(() => { console.error('Test agent could not start'); process.exitCode = 1; if (process.connected) process.disconnect(); });

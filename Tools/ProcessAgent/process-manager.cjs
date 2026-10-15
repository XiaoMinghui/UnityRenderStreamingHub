'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter, once } = require('node:events');

const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,128}$/.test(value);
function integer(value, fallback, min, max) {
  const result = value === undefined ? fallback : value;
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(`Expected integer in range ${min}..${max}`);
  return result;
}
function loadConfig(filename) {
  const location = path.resolve(filename), base = path.dirname(location);
  const input = JSON.parse(fs.readFileSync(location, 'utf8'));
  if (!validId(input.agentId)) throw new Error('Configure a valid agentId');
  const url = new URL(input.serverUrl);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.pathname !== '/agent' || url.username || url.password || url.search || url.hash)
    throw new Error('serverUrl must be a ws:// or wss:// URL ending in /agent without credentials or query');
  const signaling = new URL(input.signalingUrl || new URL('/pool', url).href);
  if (!['ws:', 'wss:'].includes(signaling.protocol) || signaling.pathname !== '/pool' || signaling.username || signaling.password || signaling.search || signaling.hash)
    throw new Error('signalingUrl must end in /pool without credentials or query');
  if (!Array.isArray(input.instances) || !input.instances.length || input.instances.length > 200) throw new Error('Configure 1..200 instances');
  const ids = new Set();
  const instances = input.instances.map(item => {
    if (!validId(item.instanceId) || !validId(item.poolId) || ids.has(item.instanceId)) throw new Error('Each instance needs a unique instanceId and valid poolId');
    ids.add(item.instanceId);
    if (typeof item.executable !== 'string' || !item.executable) throw new Error('Configure an executable');
    const executable = path.resolve(base, item.executable);
    if (!fs.statSync(executable).isFile() || /\.(cmd|bat|ps1)$/i.test(executable)) throw new Error('Use a native executable, not a shell script');
    const cwd = item.cwd ? path.resolve(base, item.cwd) : path.dirname(executable);
    if (!fs.statSync(cwd).isDirectory()) throw new Error('Working directory does not exist');
    const args = item.args || [];
    if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string' && !arg.includes('\0'))) throw new Error('args must be an array of strings');
    const env = item.env || {};
    if (!env || Array.isArray(env) || typeof env !== 'object' || !Object.entries(env).every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string' && !value.includes('\0')))
      throw new Error('env must contain string environment values');
    return { instanceId: item.instanceId, poolId: item.poolId, executable, cwd, args, env,
      autoStart: item.autoStart === true, autoRestart: item.autoRestart !== false,
      maxRestarts: integer(item.maxRestarts, 5, 0, 100), restartDelayMs: integer(item.restartDelayMs, 2000, 100, 60000) };
  });
  return { agentId: input.agentId, serverUrl: url.href, signalingUrl: signaling.href, instances,
    maxProcesses: integer(input.maxProcesses, instances.length, 1, instances.length),
    logDirectory: path.resolve(base, input.logDirectory || 'logs'),
    stopTimeoutMs: integer(input.stopTimeoutMs, 5000, 100, 8000),
    reconnectDelayMs: integer(input.reconnectDelayMs, 3000, 100, 30000) };
}

class ProcessManager extends EventEmitter {
  constructor(config, senderToken) {
    super(); this.config = config; this.senderToken = senderToken; this.closing = false; this.busy = new Set();
    fs.mkdirSync(config.logDirectory, { recursive: true });
    this.entries = new Map(config.instances.map(definition => [definition.instanceId, {
      definition, state: 'stopped', desiredRunning: false, restarts: 0, failures: 0, child: null, timer: null
    }]));
    this.secrets = [...new Set([senderToken, ...Object.entries(process.env).filter(([k]) => /TOKEN|SECRET|PASSWORD/i.test(k)).map(([, v]) => v),
      ...config.instances.flatMap(i => Object.entries(i.env).filter(([k]) => /TOKEN|SECRET|PASSWORD/i.test(k)).map(([, v]) => v))].filter(Boolean))];
  }
  redact(text) { for (const secret of this.secrets) text = text.split(secret).join('[redacted]'); return text; }
  changed() { this.emit('status', this.snapshot()); }
  snapshot() {
    return [...this.entries.values()].map(e => ({ instanceId: e.definition.instanceId, poolId: e.definition.poolId,
      state: e.state, desiredRunning: e.desiredRunning, pid: e.child?.pid, restarts: e.restarts,
      lastError: e.lastError, lastExit: e.lastExit }));
  }
  logPath(entry) { return path.join(this.config.logDirectory, entry.definition.instanceId + '.log'); }
  append(entry, text) {
    try {
      const filename = this.logPath(entry);
      if (fs.existsSync(filename) && fs.statSync(filename).size >= 5 * 1024 * 1024) {
        fs.renameSync(filename, filename + '.1');
      }
      fs.appendFileSync(filename, text);
    } catch (_) { entry.lastError = 'Unable to write process log'; }
  }
  logs(instanceId) {
    const entry = this.entries.get(instanceId); if (!entry) throw new Error('Unknown instance');
    const filename = this.logPath(entry); if (!fs.existsSync(filename)) return 'No process output recorded.';
    const fd = fs.openSync(filename, 'r');
    try {
      const size = fs.fstatSync(fd).size, buffer = Buffer.alloc(Math.min(size, 16384));
      fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
      return Buffer.from(this.redact(buffer.toString('utf8')), 'utf8').subarray(-8192).toString('utf8');
    } finally { fs.closeSync(fd); }
  }
  async operate(instanceId, action) {
    const entry = this.entries.get(instanceId);
    if (!entry || !['start', 'stop', 'restart', 'logs'].includes(action)) throw new Error('Unknown configured instance or action');
    if (action === 'logs') return this.logs(instanceId);
    if (this.closing || this.busy.has(instanceId)) throw new Error('Instance operation is already in progress or agent is closing');
    this.busy.add(instanceId);
    try {
      if (action === 'stop' || action === 'restart') await this.stop(entry);
      if (action === 'start' || action === 'restart') {
        if (entry.child) return;
        clearTimeout(entry.timer); entry.timer = null; entry.failures = 0; entry.desiredRunning = true;
        await this.launch(entry);
      }
    } finally { this.busy.delete(instanceId); this.changed(); }
  }
  async launch(entry) {
    if (this.closing || !entry.desiredRunning || entry.child) return;
    if ([...this.entries.values()].filter(e => !!e.child).length >= this.config.maxProcesses) {
      entry.state = 'failed'; entry.desiredRunning = false; entry.lastError = 'Configured process limit reached'; throw new Error(entry.lastError);
    }
    entry.state = 'starting'; entry.lastError = undefined;
    const env = { ...process.env, ...entry.definition.env };
    for (const key of Object.keys(env)) if (/^RENDERSTREAMING_(ADMIN_TOKEN|AGENT_TOKEN|MANAGED|POOL_TOKEN|INSTANCE_ID|POOL_ID|SIGNALING_URL)$/i.test(key)) delete env[key];
    Object.assign(env, { RENDERSTREAMING_MANAGED: '1', RENDERSTREAMING_POOL_TOKEN: this.senderToken,
      RENDERSTREAMING_INSTANCE_ID: entry.definition.instanceId, RENDERSTREAMING_POOL_ID: entry.definition.poolId,
      RENDERSTREAMING_SIGNALING_URL: this.config.signalingUrl });
    const child = entry.child = spawn(entry.definition.executable, entry.definition.args, {
      cwd: entry.definition.cwd, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    });
    const startedAt = Date.now(); let finished = false;
    this.append(entry, `\n[agent] Starting ${entry.definition.instanceId} at ${new Date().toISOString()}\n`);
    child.stdout.on('data', data => this.append(entry, data)); child.stderr.on('data', data => this.append(entry, data));
    const finish = (code, signal, failed = false) => {
      if (finished) return; finished = true; entry.child = null;
      entry.lastExit = `${new Date().toISOString()} code=${code} signal=${signal || 'none'}`;
      this.append(entry, `\n[agent] Exited ${entry.lastExit}\n`);
      if (entry.desiredRunning && !this.closing) {
        if (Date.now() - startedAt >= 60000) entry.failures = 0;
        entry.failures++;
        if (entry.definition.autoRestart && entry.failures <= entry.definition.maxRestarts) {
          entry.state = 'backoff';
          entry.timer = setTimeout(() => { entry.timer = null; entry.restarts++; this.launch(entry).catch(() => {}); this.changed(); },
            Math.min(30000, entry.definition.restartDelayMs * Math.pow(2, entry.failures - 1)));
        } else { entry.state = 'failed'; entry.lastError = failed ? 'Process failed to start' : 'Process exited; automatic restart disabled or retry limit reached'; }
      } else entry.state = 'stopped';
      this.changed();
    };
    child.once('exit', (code, signal) => finish(code, signal));
    child.once('error', () => finish(null, null, true));
    this.changed();
    await new Promise((resolve, reject) => {
      child.once('spawn', () => { entry.state = 'running'; this.changed(); resolve(); });
      child.once('error', () => reject(new Error('Process failed to start; check configured executable and permissions')));
    });
  }
  async stop(entry) {
    entry.desiredRunning = false; clearTimeout(entry.timer); entry.timer = null;
    const child = entry.child;
    if (!child) { entry.state = 'stopped'; this.changed(); return; }
    entry.state = 'stopping'; this.changed();
    const exited = once(child, 'exit');
    if (process.platform === 'win32') {
      // taskkill operates only on the exact child PID owned by this manager.
      const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => { try { child.kill('SIGKILL'); } catch (_) { /* child already exited */ } });
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch (_) { child.kill('SIGTERM'); }
    }
    let timer;
    const done = await Promise.race([exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), this.config.stopTimeoutMs); })]); clearTimeout(timer);
    if (!done) {
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch (_) { /* child already exited */ }
      let forceTimer;
      const killed = await Promise.race([exited.then(() => true), new Promise(resolve => { forceTimer = setTimeout(() => resolve(false), 2000); })]); clearTimeout(forceTimer);
      if (!killed) { entry.lastError = 'Process did not exit; refusing to create a duplicate'; throw new Error(entry.lastError); }
    }
    entry.state = 'stopped'; this.changed();
  }
  async close() {
    this.closing = true;
    const outcomes = await Promise.allSettled([...this.entries.values()].map(entry => this.stop(entry)));
    if (outcomes.some(result => result.status === 'rejected')) throw new Error('Some managed processes could not be stopped');
  }
}
module.exports = { loadConfig, ProcessManager };

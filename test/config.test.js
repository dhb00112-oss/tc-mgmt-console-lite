import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-config-'));

async function loadWith(raw, env = {}) {
  const file = path.join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(raw));
  const previous = { config: process.env.APP_CONFIG, nodeEnv: process.env.NODE_ENV };
  process.env.APP_CONFIG = file;
  if (env.NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = env.NODE_ENV;
  try {
    // Await inside the try so the env vars are still set while loadConfig runs.
    return await requireLoad();
  } finally {
    if (previous.config === undefined) delete process.env.APP_CONFIG; else process.env.APP_CONFIG = previous.config;
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.nodeEnv;
  }
}

async function requireLoad() {
  const { loadConfig } = await import('../src/config.js');
  return loadConfig();
}

const validCommand = {
  listenHost: '127.0.0.1',
  listenPort: 8095,
  mode: 'command',
  adapter: { command: 'adapters\\tc-mgr-adapter.cmd', timeoutMs: 20000, statusCacheMs: 1000 },
  targets: [{ key: 't1', name: 'Manager One', managerId: 'PoolA', jmxUrl: 'service:jmx:rmi:///jndi/rmi://host:8088/jmxrmi' }]
};

test('loads defaults in demo mode with a target list', async () => {
  const config = await loadWith({ targets: [{ key: 't1', name: 'n', managerId: 'PoolA', jmxUrl: 'service:jmx:rmi:///jndi/rmi://h:1/j' }] });
  assert.equal(config.mode, 'demo');
  assert.equal(config.listenPort, 8095);
  assert.equal(config.sessionMinutes, 15);
  assert.equal(config.demoLogin.username, 'demo');
  assert.equal(config.adapter.timeoutMs, 30000);
  assert.equal(config.targets.length, 1);
});

test('accepts a full command-mode config', async () => {
  const config = await loadWith(validCommand);
  assert.equal(config.mode, 'command');
  assert.equal(config.targets[0].key, 't1');
});

test('production refuses demo mode', async () => {
  await assert.rejects(() => loadWith({ mode: 'demo' }, { NODE_ENV: 'production' }), /demo/);
});

test('command mode requires at least one target', async () => {
  await assert.rejects(() => loadWith({ mode: 'command' }), /at least one/);
});

test('rejects invalid target keys and missing fields', async () => {
  await assert.rejects(() => loadWith({ mode: 'command', targets: [{ key: 'bad key!', name: 'n', managerId: 'm', jmxUrl: 'j' }] }), /Invalid target key/);
  await assert.rejects(() => loadWith({ mode: 'command', targets: [{ key: 'ok', name: '', managerId: 'm', jmxUrl: 'j' }] }), /name/);
  await assert.rejects(() => loadWith({ mode: 'command', targets: [{ key: 'ok', name: 'n', managerId: '', jmxUrl: 'j' }] }), /managerId/);
  await assert.rejects(() => loadWith({
    mode: 'command',
    targets: [
      { key: 'dup', name: 'a', managerId: 'm', jmxUrl: 'j' },
      { key: 'dup', name: 'b', managerId: 'm', jmxUrl: 'j' }
    ]
  }), /Duplicate target key/);
});

test('rejects out-of-range numeric settings', async () => {
  await assert.rejects(() => loadWith({ adapter: { timeoutMs: 100 } }), /timeoutMs/);
  await assert.rejects(() => loadWith({ adapter: { statusCacheMs: 999999 } }), /statusCacheMs/);
  await assert.rejects(() => loadWith({ sessionMinutes: 0 }), /sessionMinutes/);
  await assert.rejects(() => loadWith({ listenPort: 70000 }), /listenPort/);
});

test('tls requires key, cert and https publicBaseUrl', async () => {
  await assert.rejects(() => loadWith({ tls: { enabled: true } }), /keyPath/);
  await assert.rejects(() => loadWith({ tls: { enabled: true, keyPath: 'k', certPath: 'c' } }), /https/);
});

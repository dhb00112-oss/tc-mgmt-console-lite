// Regression test for the command-mode login path: the demo-mode HTTP tests
// short-circuit before the verifiedTargetKey audit line, which once hid a
// ReferenceError there (500 on successful real logins). This test runs the
// real adapter chain against the local JMX stub and logs in over HTTP.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jar = path.join(rootDir, 'adapters', 'tc-mgr-jmx.jar');
const javaHome = process.env.TC_JAVA_HOME || process.env.JAVA_HOME;

function tool(name) {
  if (javaHome && fs.existsSync(path.join(javaHome, 'bin', `${name}.exe`))) {
    return path.join(javaHome, 'bin', `${name}.exe`);
  }
  return name;
}

const javaOk = process.platform === 'win32'
  && fs.existsSync(jar)
  && !spawnSync(tool('javac'), ['-version'], { encoding: 'utf8', timeout: 30_000 }).error;

let stubProcess = null;
let stubUrl = null;
let server = null;
let port = 0;
let buildDir = null;

before(async () => {
  if (!javaOk) return;
  buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-login-'));
  const compiled = spawnSync(tool('javac'), ['--release', '11', '-encoding', 'UTF-8', '-d', buildDir,
    path.join(rootDir, 'test', 'fixtures', 'stub-jmx', 'StubMgrJmxServer.java')], { encoding: 'utf8', timeout: 120_000 });
  if (compiled.status !== 0) throw new Error(`Stub compilation failed: ${compiled.stderr}`);
  stubProcess = spawn(tool('java'), ['-cp', buildDir, 'StubMgrJmxServer', 'PoolA'], { stdio: ['ignore', 'pipe', 'pipe'] });
  stubUrl = await new Promise((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(() => reject(new Error('Stub did not report ready')), 30_000);
    stubProcess.stdout.on('data', (chunk) => {
      buffered += chunk;
      const line = buffered.split(/\r?\n/).find((entry) => entry.startsWith('READY '));
      if (line) { clearTimeout(timer); resolve(line.slice('READY '.length).trim()); }
    });
    stubProcess.on('close', () => { clearTimeout(timer); reject(new Error('Stub exited')); });
  });

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-login-cfg-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    listenHost: '127.0.0.1',
    listenPort: 18096,
    publicBaseUrl: 'http://127.0.0.1:18096',
    sessionMinutes: 15,
    mode: 'command',
    adapter: { command: path.join(rootDir, 'adapters', 'tc-mgr-adapter.cmd'), timeoutMs: 60_000, statusCacheMs: 0 },
    audit: { enabled: false, reverseDns: false, trustedProxies: ['127.0.0.1'] },
    tls: { enabled: false },
    targets: [{ key: 'stub-poola', name: 'PoolA(STUB:8088)', managerId: 'PoolA', jmxUrl: stubUrl }]
  }));
  process.env.APP_CONFIG = configPath;
  delete process.env.NODE_ENV;
  // Query string forces a fresh module instance with this APP_CONFIG.
  const { handle } = await import('../src/server.js?command-login');
  server = http.createServer(handle);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (stubProcess) stubProcess.kill();
  if (buildDir) fs.rmSync(buildDir, { recursive: true, force: true });
});

function request(pathname, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method,
      headers: { ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}), ...headers }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : {} }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('command mode: correct Server Manager credentials log in over HTTP', { skip: !javaOk }, async () => {
  const ok = await request('/api/login', { method: 'POST', body: JSON.stringify({ username: 'test-operator', password: 'stub-secret' }) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.demo, false);
  assert.ok(ok.body.csrf);

  const cookie = ok.headers['set-cookie'][0].split(';')[0];
  const list = await request('/api/processes', { headers: { Cookie: cookie } });
  assert.equal(list.status, 200);
  assert.equal(list.body.processes.length, 2);
});

test('command mode: wrong Server Manager credentials are rejected with 401', { skip: !javaOk }, async () => {
  const bad = await request('/api/login', { method: 'POST', body: JSON.stringify({ username: 'test-operator', password: 'nope' }) });
  assert.equal(bad.status, 401);
});

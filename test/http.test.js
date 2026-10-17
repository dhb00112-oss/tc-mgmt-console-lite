// HTTP-level integration test of the slim console using demo mode.
// trustedProxies trusts the loopback tester so every group can use its own
// X-Forwarded-For address and the login rate limiter stays isolated per test.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-http-'));
const configPath = path.join(dir, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({
  listenHost: '127.0.0.1',
  listenPort: 18095,
  publicBaseUrl: 'http://127.0.0.1:18095',
  sessionMinutes: 15,
  mode: 'demo',
  processLog: { mode: 'demo', pathPrefixes: { PoolA: 'D:\\tc\\logs\\ServerManagers\\PoolA\\TcServer\\process' } },
  audit: { enabled: false, reverseDns: false, trustedProxies: ['127.0.0.1'] },
  tls: { enabled: false },
  targets: [{ key: 'demo-poola', name: 'PoolA(DEMO-01:8088)', managerId: 'PoolA', jmxUrl: 'service:jmx:rmi:///jndi/rmi://DEMO-01:8088/jmxrmi' }]
}));
process.env.APP_CONFIG = configPath;
delete process.env.NODE_ENV;
const { handle } = await import('../src/server.js');

const server = http.createServer(handle);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

function request(pathname, { method = 'GET', body, headers = {}, ip = '10.1.1.1' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method,
      headers: {
        'X-Forwarded-For': ip,
        ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
        ...headers
      }
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

test.after(() => new Promise((resolve) => server.close(resolve)));

test('login rejects wrong credentials and accepts demo credentials', async () => {
  const bad = await request('/api/login', { method: 'POST', ip: '10.1.1.1', body: JSON.stringify({ username: 'demo', password: 'nope' }) });
  assert.equal(bad.status, 401);

  const ok = await request('/api/login', { method: 'POST', ip: '10.1.1.1', body: JSON.stringify({ username: 'demo', password: 'demo' }) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.userId, 'demo');
  assert.ok(ok.body.csrf);
  assert.equal(ok.body.demo, true);
  assert.match(ok.headers['set-cookie'][0], /HttpOnly/);
});

test('status without a session is 401 and with one returns demo fixture data', async () => {
  const anonymous = await request('/api/status', { ip: '10.1.2.1' });
  assert.equal(anonymous.status, 401);

  const login = await request('/api/login', { method: 'POST', ip: '10.1.2.1', body: JSON.stringify({ username: 'demo', password: 'demo' }) });
  const cookie = login.headers['set-cookie'][0].split(';')[0];

  const status = await request('/api/status', { ip: '10.1.2.1', headers: { Cookie: cookie } });
  assert.equal(status.status, 200);
  assert.equal(status.body.demo, true);
  assert.equal(status.body.targets.length, 1);
  assert.equal(status.body.targets[0].name, 'PoolA(DEMO-01:8088)');
  const poola = status.body.statuses.find((item) => item.targetKey === 'demo-poola');
  assert.equal(poola.attributes['Number of Servers'], '3');
  assert.equal(poola.attributes['Number of Warm Servers'], '1');
  assert.ok(poola.attributes['Host']);
  assert.ok(poola.attributes['Last Restart Warm Servers Time']);
});

test('restart-warm requires CSRF, validates the target and succeeds with it', async () => {
  const login = await request('/api/login', { method: 'POST', ip: '10.1.3.1', body: JSON.stringify({ username: 'demo', password: 'demo' }) });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const csrf = login.body.csrf;

  const noCsrf = await request('/api/operation/restart-warm', { method: 'POST', ip: '10.1.3.1', headers: { Cookie: cookie }, body: JSON.stringify({ targetKey: 'demo-poola' }) });
  assert.equal(noCsrf.status, 403);

  const unknown = await request('/api/operation/restart-warm', { method: 'POST', ip: '10.1.3.1', headers: { Cookie: cookie, 'X-CSRF-Token': csrf }, body: JSON.stringify({ targetKey: 'nope' }) });
  assert.equal(unknown.status, 400);

  const ok = await request('/api/operation/restart-warm', { method: 'POST', ip: '10.1.3.1', headers: { Cookie: cookie, 'X-CSRF-Token': csrf }, body: JSON.stringify({ targetKey: 'demo-poola' }) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.restarted, true);
});

test('logout clears the session', async () => {
  const login = await request('/api/login', { method: 'POST', ip: '10.1.4.1', body: JSON.stringify({ username: 'demo', password: 'demo' }) });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const csrf = login.body.csrf;

  const out = await request('/api/logout', { method: 'POST', ip: '10.1.4.1', headers: { Cookie: cookie, 'X-CSRF-Token': csrf }, body: '{}' });
  assert.equal(out.status, 200);

  const after = await request('/api/session', { ip: '10.1.4.1', headers: { Cookie: cookie } });
  assert.equal(after.status, 401);
});

test('process list returns demo fixture and log path resolves on demand', async () => {
  const login = await request('/api/login', { method: 'POST', ip: '10.1.6.1', body: JSON.stringify({ username: 'demo', password: 'demo' }) });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const csrf = login.body.csrf;

  const noCsrf = await request('/api/processes/terminate', { method: 'POST', ip: '10.1.6.1', headers: { Cookie: cookie }, body: JSON.stringify({ targetKey: 'demo-poola', id: 'x' }) });
  assert.equal(noCsrf.status, 403);

  const list = await request('/api/processes', { ip: '10.1.6.1', headers: { Cookie: cookie } });
  assert.equal(list.status, 200);
  assert.equal(list.body.processes.length, 3);
  const first = list.body.processes.find((item) => item.pid === '9496');
  assert.equal(first.serverId, 'tcserver00158@PoolA@4144@DEMO-01');
  assert.equal(first.lifecycle, 'Assigned');
  assert.equal(first.mode, 'Read');
  assert.equal(first.status, 'Idle');
  // Log names are NOT part of the list anymore; they resolve on demand.
  assert.equal(first.logFile, undefined);

  const logPath = await request('/api/process/log-path', {
    method: 'POST', ip: '10.1.6.1', headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
    body: JSON.stringify({ targetKey: 'demo-poola', id: first.id })
  });
  assert.equal(logPath.status, 200);
  assert.equal(logPath.body.logFile, 'tcserver.exe2518e80a.syslog');
  assert.match(logPath.body.logPath, /^D:\\.*tcserver\.exe2518e80a\.syslog$/);

  const manage = await request('/api/process/manage', {
    method: 'POST', ip: '10.1.6.1', headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
    body: JSON.stringify({ targetKey: 'demo-poola', serverId: first.serverId, manageOp: 'log-levels' })
  });
  assert.equal(manage.status, 200);
  assert.ok(manage.body.loggers.some((l) => l.name === 'Teamcenter'));

  const manageNoCsrf = await request('/api/process/manage', {
    method: 'POST', ip: '10.1.6.1', headers: { Cookie: cookie },
    body: JSON.stringify({ targetKey: 'demo-poola', serverId: first.serverId, manageOp: 'log-levels' })
  });
  assert.equal(manageNoCsrf.status, 403);

  const unknown = await request('/api/processes/terminate', { method: 'POST', ip: '10.1.6.1', headers: { Cookie: cookie, 'X-CSRF-Token': csrf }, body: JSON.stringify({ targetKey: 'demo-poola', id: 'demo-poola:xxx:yyy' }) });
  assert.equal(unknown.status, 404);

  const ok = await request('/api/processes/terminate', { method: 'POST', ip: '10.1.6.1', headers: { Cookie: cookie, 'X-CSRF-Token': csrf }, body: JSON.stringify({ targetKey: 'demo-poola', id: first.id }) });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.terminated, true);

  const after = await request('/api/processes', { ip: '10.1.6.1', headers: { Cookie: cookie } });
  assert.equal(after.body.processes.length, 2);
  assert.equal(after.body.processes.some((item) => item.pid === '9496'), false);
});

test('batch terminate validates input, reports per-id results and audits', async () => {
  const login = await request('/api/login', { method: 'POST', ip: '10.1.7.1', body: JSON.stringify({ username: 'demo', password: 'demo' }) });
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const csrf = login.body.csrf;

  const noCsrf = await request('/api/processes/terminate-batch', { method: 'POST', ip: '10.1.7.1', headers: { Cookie: cookie }, body: JSON.stringify({ ids: ['x'] }) });
  assert.equal(noCsrf.status, 403);

  const empty = await request('/api/processes/terminate-batch', { method: 'POST', ip: '10.1.7.1', headers: { Cookie: cookie, 'X-CSRF-Token': csrf }, body: JSON.stringify({ ids: [] }) });
  assert.equal(empty.status, 400);

  const oversized = await request('/api/processes/terminate-batch', { method: 'POST', ip: '10.1.7.1', headers: { Cookie: cookie, 'X-CSRF-Token': csrf }, body: JSON.stringify({ ids: Array.from({ length: 51 }, (_, i) => `id-${i}`) }) });
  assert.equal(oversized.status, 400);

  const list = await request('/api/processes', { ip: '10.1.7.1', headers: { Cookie: cookie } });
  const ids = list.body.processes.map((item) => item.id);

  const batch = await request('/api/processes/terminate-batch', {
    method: 'POST', ip: '10.1.7.1', headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
    body: JSON.stringify({ ids: [...ids, 'demo-poola:xxx:yyy'] })
  });
  assert.equal(batch.status, 200);
  const byId = Object.fromEntries(batch.body.results.map((entry) => [entry.id, entry]));
  for (const id of ids) assert.equal(byId[id].terminated, true);
  assert.equal(byId['demo-poola:xxx:yyy'].terminated, false);
  assert.equal(byId['demo-poola:xxx:yyy'].reason, 'not-found');

  const after = await request('/api/processes', { ip: '10.1.7.1', headers: { Cookie: cookie } });
  assert.equal(after.body.processes.length, 0);
});

test('login rate limiting trips after 10 attempts per source', async () => {
  let last;
  for (let attempt = 0; attempt < 11; attempt += 1) {
    last = await request('/api/login', { method: 'POST', ip: '10.1.5.9', body: JSON.stringify({ username: 'demo', password: 'demo' }) });
  }
  assert.equal(last.status, 429);
});

test('static pages are served with the security headers', async () => {
  const page = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    }).on('error', reject);
  });
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(page.body, /Management Console/);
});

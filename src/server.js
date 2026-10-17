import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { SessionStore } from './session-store.js';
import { createManagerAdapter } from './adapters/manager.js';
import { createProcessLogResolver } from './adapters/process-logs.js';
import { AuditLogger, requestIp } from './audit.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const pidFile = path.resolve(process.env.APP_PID_FILE || path.join(root, 'mgmt-console-lite.pid'));
const config = loadConfig();
const sessions = new SessionStore(config.sessionMinutes * 60_000);
const manager = createManagerAdapter(config);
const logResolver = createProcessLogResolver(config.processLog);
const audit = new AuditLogger(config.audit);
const loginAttempts = new Map();

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie ?? '').split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter((x) => x.length === 2));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16_384) throw Object.assign(new Error('Request body too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
}

function getSession(req) {
  return sessions.get(cookies(req).tc_lite_session);
}

function requireSession(req, res) {
  const session = getSession(req);
  if (!session) json(res, 401, { error: '请重新登录' });
  return session;
}

function requireCsrf(req, res, session) {
  if (req.headers['x-csrf-token'] !== session.csrf) {
    json(res, 403, { error: '请求校验失败，请刷新页面后重试' });
    return false;
  }
  return true;
}

function allowLogin(ip) {
  const now = Date.now();
  const record = loginAttempts.get(ip) ?? { count: 0, since: now };
  if (now - record.since > 5 * 60_000) { record.count = 0; record.since = now; }
  record.count += 1;
  loginAttempts.set(ip, record);
  return record.count <= 10;
}

function serveStatic(req, res, pathname) {
  const names = { '/': 'index.html', '/app.js': 'app.js', '/styles.css': 'styles.css' };
  const name = names[pathname];
  if (!name) return false;
  const type = name.endsWith('.html') ? 'text/html' : name.endsWith('.js') ? 'text/javascript' : 'text/css';
  res.writeHead(200, {
    'Content-Type': `${type}; charset=utf-8`,
    'Cache-Control': name === 'index.html' ? 'no-store' : 'public, max-age=300',
    'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer'
  });
  fs.createReadStream(path.join(publicDir, name)).pipe(res);
  return true;
}

function describeAdapterError(error) {
  // JMX auth failures surface as opaque UnmarshalException/NotSerializableException
  // (the TC server wraps the non-serializable LDAP context), so only the class
  // name is meaningful in the browser; the full text stays in logs.
  return `${error.message}`.slice(0, 300);
}

export async function handle(req, res) {
  const url = new URL(req.url, config.publicBaseUrl);
  try {
    if (req.method === 'GET' && serveStatic(req, res, url.pathname)) return;
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { status: 'ok', mode: config.mode });

    if (req.method === 'POST' && url.pathname === '/api/login') {
      const client = await audit.client(req);
      if (!allowLogin(requestIp(req, config.audit.trustedProxies))) {
        audit.record('login_rate_limited', client);
        return json(res, 429, { error: '登录尝试过多，请稍后重试' });
      }
      const body = await readJson(req);
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      if (!username || username.length > 128 || !password || password.length > 512) {
        return json(res, 400, { error: '请输入有效账号和密码' });
      }
      const credentials = { username, password };
      // Declared here so the success audit below can reference them in both modes.
      let verified = false;
      let verifiedTargetKey = '';
      if (config.mode === 'demo') {
        if (username !== config.demoLogin.username || password !== config.demoLogin.password) {
          audit.record('login_failed', { attemptedUserId: username, error: 'demo credentials mismatch', ...client });
          return json(res, 401, { error: '账号或密码错误' });
        }
        verified = true;
      } else {
        // Login IS the Server Manager authentication: try a real status read
        // with the entered credentials until one configured manager accepts.
        let lastError = '';
        try {
          const result = await manager.listStatus(credentials);
          verified = result.statuses.length > 0;
          verifiedTargetKey = result.statuses[0]?.targetKey ?? '';
          if (!verified) lastError = result.failures.map((f) => f.error).join('; ');
        } catch (error) {
          lastError = describeAdapterError(error);
        }
        if (!verified) {
          audit.record('login_failed', { attemptedUserId: username, error: lastError || 'no target accepted the credentials', ...client });
          console.warn(`login failed for ${username}: ${lastError}`);
          return json(res, 401, { error: '登录失败：账号或密码错误，或 Server Manager 暂不可达' });
        }
      }
      const session = sessions.create(username, credentials);
      audit.record('login_success', { userId: username, authTarget: config.mode === 'demo' ? 'demo' : verifiedTargetKey, ...client });
      const secure = new URL(config.publicBaseUrl).protocol === 'https:' ? '; Secure' : '';
      return json(res, 200, { userId: username, csrf: session.csrf, demo: config.mode === 'demo' }, {
        'Set-Cookie': `tc_lite_session=${encodeURIComponent(session.id)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${config.sessionMinutes * 60}${secure}`
      });
    }

    if (req.method === 'GET' && url.pathname === '/api/session') {
      const session = requireSession(req, res); if (!session) return;
      return json(res, 200, { userId: session.userId, csrf: session.csrf, demo: config.mode === 'demo' });
    }

    if (req.method === 'GET' && url.pathname === '/api/status') {
      const session = requireSession(req, res); if (!session) return;
      const result = await manager.listStatus(session.credentials);
      audit.record('status_viewed', { userId: session.userId, targets: result.statuses.length, ...await audit.client(req) });
      return json(res, 200, {
        demo: config.mode === 'demo',
        targets: config.targets.map(({ key, name, managerId }) => ({ key, name, managerId })),
        ...result
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/operation/restart-warm') {
      const session = requireSession(req, res); if (!session || !requireCsrf(req, res, session)) return;
      const body = await readJson(req);
      const targetKey = typeof body.targetKey === 'string' ? body.targetKey : '';
      const target = config.targets.find((item) => item.key === targetKey);
      if (!target) return json(res, 400, { error: '无效的 Server Manager 标识' });
      const client = await audit.client(req);
      const operationAudit = { userId: session.userId, targetKey, managerId: target.managerId, ...client };
      audit.record('restart_warm_requested', operationAudit);
      try {
        await manager.restartWarm(session.credentials, targetKey);
        audit.record('restart_warm_succeeded', operationAudit);
      } catch (error) {
        audit.record('restart_warm_failed', { ...operationAudit, error: describeAdapterError(error) });
        console.warn(`restart-warm failed on ${targetKey}: ${error.message}`);
        return json(res, 502, { error: '重启 Warm 服务器失败：命令未被 Server Manager 接受，请稍后重试' });
      }
      return json(res, 200, { restarted: true, targetKey });
    }

    if (req.method === 'GET' && url.pathname === '/api/processes') {
      const session = requireSession(req, res); if (!session) return;
      const result = await manager.listProcesses(session.credentials);
      audit.record('processes_viewed', { userId: session.userId, processes: result.processes.length, ...await audit.client(req) });
      return json(res, 200, {
        demo: config.mode === 'demo',
        targets: config.targets.map(({ key, name, managerId }) => ({ key, name, managerId })),
        ...result
      });
    }

    // On-demand syslog path lookup for one process (Oracle query happens here,
    // not on every list refresh).
    if (req.method === 'POST' && url.pathname === '/api/process/log-path') {
      const session = requireSession(req, res); if (!session || !requireCsrf(req, res, session)) return;
      const body = await readJson(req);
      const targetKey = typeof body.targetKey === 'string' ? body.targetKey : '';
      const id = typeof body.id === 'string' ? body.id : '';
      if (!/^[A-Za-z0-9_.:@-]{1,200}$/.test(id) || !config.targets.some((item) => item.key === targetKey)) {
        return json(res, 400, { error: '无效的进程标识' });
      }
      const current = await manager.listProcesses(session.credentials);
      const selected = current.processes.find((item) => item.id === id);
      if (!selected) return json(res, 404, { error: '进程已不存在，请刷新列表' });
      try {
        const info = await logResolver.lookup(selected.pid, selected.pool, selected.managerId);
        return json(res, 200, { pid: selected.pid, pool: selected.pool, ...info });
      } catch (error) {
        return json(res, 502, { error: `日志路径查询失败：${describeAdapterError(error)}` });
      }
    }

    // Per-TC-server management (Logging / Log Levels / Monitoring), dispatched
    // through the JMX bridge with the same MBean calls as the original console.
    const MANAGE_OPS = new Set([
      'server-log-status', 'set-sql-logging', 'show-syslog', 'show-journal',
      'journal-action', 'stats-action', 'journal-modules', 'set-journal-modules',
      'log-levels', 'set-log-level', 'monitoring-status', 'set-monitoring-mode',
      'metric-events', 'clear-metric-history'
    ]);
    const MANAGE_AUDITED = new Set([
      'set-sql-logging', 'show-syslog', 'show-journal', 'journal-action', 'stats-action',
      'set-journal-modules', 'set-log-level', 'set-monitoring-mode', 'clear-metric-history'
    ]);
    if (req.method === 'POST' && url.pathname === '/api/process/manage') {
      const session = requireSession(req, res); if (!session || !requireCsrf(req, res, session)) return;
      const body = await readJson(req);
      const targetKey = typeof body.targetKey === 'string' ? body.targetKey : '';
      const serverId = typeof body.serverId === 'string' ? body.serverId : '';
      const manageOp = typeof body.manageOp === 'string' ? body.manageOp : '';
      const arg1 = typeof body.arg1 === 'string' ? body.arg1.slice(0, 4096) : '';
      const arg2 = typeof body.arg2 === 'string' ? body.arg2.slice(0, 4096) : '';
      if (!MANAGE_OPS.has(manageOp)) return json(res, 400, { error: '不支持的管理操作' });
      if (!/^[A-Za-z0-9_.:@-]{1,200}$/.test(serverId) || !config.targets.some((item) => item.key === targetKey)) {
        return json(res, 400, { error: '无效的进程标识' });
      }
      if (MANAGE_AUDITED.has(manageOp)) {
        audit.record(`process_manage_${manageOp}`, {
          userId: session.userId, targetKey, serverId,
          arg1: manageOp === 'show-syslog' || manageOp === 'show-journal' ? arg1 : arg1.slice(0, 200),
          arg2: arg2.slice(0, 200),
          ...await audit.client(req)
        });
      }
      try {
        const result = await manager.serverManage(session.credentials, targetKey, serverId, manageOp, arg1, arg2);
        return json(res, 200, result);
      } catch (error) {
        console.warn(`process manage ${manageOp} failed on ${serverId}: ${error.message}`);
        return json(res, 502, { error: `操作失败：${describeAdapterError(error)}` });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/processes/terminate') {
      const session = requireSession(req, res); if (!session || !requireCsrf(req, res, session)) return;
      const body = await readJson(req);
      const targetKey = typeof body.targetKey === 'string' ? body.targetKey : '';
      const id = typeof body.id === 'string' ? body.id : '';
      if (!/^[A-Za-z0-9_.:@-]{1,200}$/.test(id) || !config.targets.some((item) => item.key === targetKey)) {
        return json(res, 400, { error: '无效的进程标识' });
      }
      // Re-read the authoritative list right before shutdown so the audit
      // record carries the process state that was actually stopped.
      const current = await manager.listProcesses(session.credentials);
      const selected = current.processes.find((item) => item.id === id);
      if (!selected) return json(res, 404, { error: '进程已不存在，请刷新列表' });
      const client = await audit.client(req);
      const cleanupAudit = {
        userId: session.userId,
        targetKey,
        managerId: selected.managerId,
        serverId: selected.serverId,
        pid: selected.pid,
        pool: selected.pool,
        processOwner: selected.owner,
        ...client
      };
      audit.record('process_cleanup_requested', cleanupAudit);
      try {
        await manager.terminateProcess(session.credentials, targetKey, selected.serverId);
        audit.record('process_cleanup_succeeded', cleanupAudit);
      } catch (error) {
        audit.record('process_cleanup_failed', { ...cleanupAudit, error: describeAdapterError(error) });
        console.warn(`process cleanup failed on ${targetKey}: ${error.message}`);
        return json(res, 502, { error: '清理失败：命令未被 Server Manager 接受，请刷新后重试' });
      }
      return json(res, 200, { terminated: true, id });
    }

    if (req.method === 'POST' && url.pathname === '/api/processes/terminate-batch') {
      const session = requireSession(req, res); if (!session || !requireCsrf(req, res, session)) return;
      const body = await readJson(req);
      const valid = (value) => typeof value === 'string' && /^[A-Za-z0-9_.:@-]{1,200}$/.test(value);
      const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).filter(valid))];
      if (ids.length === 0) return json(res, 400, { error: '没有有效的进程标识' });
      if (ids.length > 50) return json(res, 400, { error: '一次最多清理 50 个进程' });
      const client = await audit.client(req);
      // The pre-check runs against one authoritative list read; every
      // terminate re-reads the list server-side, so a process that vanished
      // (or an id the JMX bridge cannot match) fails per-row without
      // affecting the others.
      const current = await manager.listProcesses(session.credentials);
      const results = [];
      const succeededPids = [];
      for (const id of ids) {
        const selected = current.processes.find((item) => item.id === id);
        if (!selected) {
          results.push({ id, terminated: false, reason: 'not-found' });
          continue;
        }
        const cleanupAudit = {
          userId: session.userId,
          targetKey: selected.targetKey,
          managerId: selected.managerId,
          serverId: selected.serverId,
          pid: selected.pid,
          pool: selected.pool,
          processOwner: selected.owner,
          batch: true,
          ...client
        };
        audit.record('process_cleanup_requested', cleanupAudit);
        try {
          await manager.terminateProcess(session.credentials, selected.targetKey, selected.serverId);
          audit.record('process_cleanup_succeeded', cleanupAudit);
          results.push({ id, terminated: true });
          succeededPids.push(selected.pid);
        } catch (error) {
          audit.record('process_cleanup_failed', { ...cleanupAudit, error: describeAdapterError(error) });
          results.push({ id, terminated: false, reason: 'failed' });
        }
      }
      audit.record('process_cleanup_batch', {
        userId: session.userId,
        pids: succeededPids,
        succeeded: results.filter((entry) => entry.terminated).length,
        failed: results.length - succeededPids.length,
        ...client
      });
      return json(res, 200, { results });
    }

    if (req.method === 'POST' && url.pathname === '/api/logout') {
      const session = getSession(req);
      if (session && !requireCsrf(req, res, session)) return;
      if (session) {
        audit.record('logout', { userId: session.userId, ...await audit.client(req) });
        sessions.delete(session.id);
      }
      return json(res, 200, { loggedOut: true }, { 'Set-Cookie': 'tc_lite_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0' });
    }
    json(res, 404, { error: 'Not found' });
  } catch (error) {
    console.error(JSON.stringify({ event: 'request_error', path: url.pathname, message: error.message }));
    json(res, error.status ?? 500, { error: error.status ? error.message : '服务暂时不可用，请稍后重试' });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = config.tls.enabled
    ? https.createServer({
        key: fs.readFileSync(config.tls.keyPath),
        cert: fs.readFileSync(config.tls.certPath),
        ...(config.tls.caPath ? { ca: fs.readFileSync(config.tls.caPath) } : {})
      }, handle)
    : http.createServer(handle);
  server.listen(config.listenPort, config.listenHost, () => {
    fs.writeFileSync(pidFile, `${process.pid}\n`, { encoding: 'utf8' });
    console.log(`TC management console lite listening on ${config.tls.enabled ? 'https' : 'http'}://${config.listenHost}:${config.listenPort}`);
    console.log(`PID ${process.pid} recorded in ${pidFile}`);
    if (config.mode === 'demo') console.warn('DEMO MODE: login with demo/demo. Never use this mode in production.');
  });

  const removePidFile = () => {
    try {
      if (fs.readFileSync(pidFile, 'utf8').trim() === String(process.pid)) fs.unlinkSync(pidFile);
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn(`Unable to remove PID file: ${error.message}`);
    }
  };
  const shutdown = (signal) => {
    console.log(`${signal} received; stopping TC management console lite.`);
    logResolver.close().catch(() => {});
    server.close(() => {
      removePidFile();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('exit', removePidFile);
}

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function javaExecutable() {
  const home = process.env.TC_JAVA_HOME || process.env.JAVA_HOME;
  return home ? path.join(home, 'bin', 'java.exe') : 'java.exe';
}

function b64(value) { return Buffer.from(String(value ?? ''), 'utf8').toString('base64'); }
function unb64(value) { return Buffer.from(value, 'base64').toString('utf8'); }
function safePart(value) { return Buffer.from(String(value), 'utf8').toString('base64url'); }

// The web server passes the logged-in user's Server Manager credentials; they
// travel to the Java bridge over stdin (base64) only — never on a command line,
// never in config files, and never in this wrapper's stdout.
function invoke(target, operation, username, password, serverId = '', arg1 = '', arg2 = '') {
  const jar = path.join(here, 'tc-mgr-jmx.jar');
  const pools = Array.isArray(target.pools) ? target.pools.join('\u001f') : '';
  const values = [operation, target.jmxUrl, target.managerId, pools, username, password, serverId, arg1, arg2];
  return new Promise((resolve, reject) => {
    const child = spawn(javaExecutable(), ['-Xmx256m', '-Xms16m', '-cp', jar, 'MgrJmxBridge'], {
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`JMX bridge failed (${code}): ${Buffer.concat(stderr).toString('utf8').slice(0, 500)}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString('utf8').trim());
    });
    child.stdin.end(`${values.map(b64).join('\n')}\n`);
  });
}

function parseStatus(output) {
  const attributes = {};
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const fields = line.split('\t');
    if (fields[0] !== 'S' || fields.length !== 3) throw new Error('JMX bridge returned malformed status data.');
    const [name, value] = fields.slice(1).map(unb64);
    attributes[name] = value.split('\u001f').join('\n');
  }
  return attributes;
}

function parseProcesses(target, output) {
  const processes = [];
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const fields = line.split('\t');
    if (fields[0] !== 'P' || fields.length !== 10) throw new Error('JMX bridge returned malformed process data.');
    const [serverId, pid, pool, host, owner, lifecycle, mode, status, duration] = fields.slice(1).map(unb64);
    processes.push({
      id: `${target.key}:${safePart(pool)}:${safePart(serverId)}`,
      targetKey: target.key,
      managerId: target.managerId,
      serverId,
      pid,
      pool,
      host,
      owner,
      lifecycle,
      mode,
      status,
      durationSeconds: Number(duration) || 0
    });
  }
  return processes;
}

function requireTarget(targets, key) {
  const target = targets.find((item) => item.key === key);
  if (!target) throw new Error(`Unknown target: ${key}`);
  return target;
}

async function run() {
  const input = await readInput();
  const username = String(input.username ?? '');
  const password = String(input.password ?? '');
  const targets = Array.isArray(input.targets) ? input.targets : [];
  if (input.operation === 'status') {
    // One unreachable Server Manager must not hide the status of the others:
    // report per-target failures alongside the successful statuses.
    const statuses = [];
    const failures = [];
    for (const target of targets) {
      try {
        const attributes = parseStatus(await invoke(target, 'status', username, password));
        statuses.push({ targetKey: target.key, managerId: target.managerId, attributes });
      } catch (error) {
        failures.push({ targetKey: target.key, error: error.message.slice(0, 300) });
      }
    }
    process.stdout.write(JSON.stringify({ statuses, failures }));
  } else if (input.operation === 'list') {
    const processes = [];
    const failures = [];
    for (const target of targets) {
      try {
        processes.push(...parseProcesses(target, await invoke(target, 'list', username, password)));
      } catch (error) {
        failures.push({ targetKey: target.key, error: error.message.slice(0, 300) });
      }
    }
    process.stdout.write(JSON.stringify({ processes, failures }));
  } else if (input.operation === 'terminate') {
    const target = requireTarget(targets, String(input.targetKey ?? ''));
    await invoke(target, 'terminate', username, password, String(input.serverId ?? ''));
    process.stdout.write(JSON.stringify({ terminated: true, targetKey: target.key, serverId: input.serverId }));
  } else if (input.operation === 'server-manage') {
    // Per-TC-server management operations (Logging / Log Levels / Monitoring),
    // faithful to the console bundle's MBean calls.
    const target = requireTarget(targets, String(input.targetKey ?? ''));
    const serverId = String(input.serverId ?? '');
    if (!serverId) throw new Error('Empty serverId.');
    const op = String(input.manageOp ?? '');
    const output = await invoke(target, op, username, password, serverId, String(input.arg1 ?? ''), String(input.arg2 ?? ''));
    const result = { op };
    const attributes = [];
    const modules = [];
    const loggers = [];
    const metrics = [];
    const responders = [];
    const events = [];
    for (const line of output.split(/\r?\n/).filter(Boolean)) {
      const fields = line.split('\t');
      const value = () => unb64(fields[1]);
      if (fields[0] === 'L' && fields.length === 3) attributes.push({ name: unb64(fields[1]), value: unb64(fields[2]) });
      else if (fields[0] === 'C' && fields.length === 2) result.content = value();
      else if (fields[0] === 'M' && fields.length === 3) modules.push({ name: unb64(fields[1]), active: unb64(fields[2]) === 'true' });
      else if (fields[0] === 'G' && fields.length === 3) loggers.push({ name: unb64(fields[1]), priority: unb64(fields[2]) });
      else if (fields[0] === 'H' && fields.length === 2) result.monitoringMode = value();
      else if (fields[0] === 'V' && fields.length === 6) metrics.push({ metricId: unb64(fields[1]), mode: unb64(fields[2]), dateStarted: unb64(fields[3]), historical: unb64(fields[4]), recent: unb64(fields[5]) });
      else if (fields[0] === 'R' && fields.length === 2) responders.push(value());
      else if (fields[0] === 'E' && fields.length === 2) events.push(value());
      else if (fields[0] === 'T') result.done = true;
    }
    if (attributes.length) result.attributes = attributes;
    if (modules.length) result.modules = modules;
    if (loggers.length) result.loggers = loggers;
    if (metrics.length) result.metrics = metrics;
    if (responders.length) result.responders = responders;
    if (events.length) result.events = events;
    process.stdout.write(JSON.stringify(result));
  } else if (input.operation === 'restart-warm') {
    const target = requireTarget(targets, String(input.targetKey ?? ''));
    await invoke(target, 'restart-warm', username, password);
    process.stdout.write(JSON.stringify({ restarted: true, targetKey: target.key }));
  } else if (input.operation === 'probe') {
    const reports = [];
    for (const target of targets) {
      const output = await invoke(target, 'probe', username, password);
      const domains = [];
      const mbeans = [];
      const attributes = [];
      let totalMBeans = 0;
      for (const line of output.split(/\r?\n/).filter(Boolean)) {
        const fields = line.split('\t');
        if (fields[0] === 'D') domains.push(unb64(fields[1]));
        else if (fields[0] === 'M' && fields.length === 3) mbeans.push({ objectName: unb64(fields[1]), className: unb64(fields[2]) });
        else if (fields[0] === 'A' && fields.length === 5) attributes.push({ objectName: unb64(fields[1]), name: unb64(fields[2]), type: unb64(fields[3]), value: unb64(fields[4]) });
        else if (fields[0] === 'T') totalMBeans = Number(unb64(fields[1])) || 0;
      }
      reports.push({ targetKey: target.key, managerId: target.managerId, domains, mbeans, attributes, totalMBeans });
    }
    process.stdout.write(JSON.stringify({ reports }));
  } else {
    throw new Error('Unsupported adapter operation.');
  }
}

try {
  await run();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

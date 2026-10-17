// End-to-end exercise of the manager adapter chain (.cmd -> Node wrapper ->
// Java bridge) against a local JMX stub with no Teamcenter involvement.
// Skips when no JDK is available; on the dev machine it runs as part of npm test.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runJsonCommand } from '../src/adapters/command.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adapter = path.join(rootDir, 'adapters', 'tc-mgr-adapter.cmd');
const jar = path.join(rootDir, 'adapters', 'tc-mgr-jmx.jar');
const javaHome = process.env.TC_JAVA_HOME || process.env.JAVA_HOME;

function tool(name) {
  if (javaHome && fs.existsSync(path.join(javaHome, 'bin', `${name}.exe`))) {
    return path.join(javaHome, 'bin', `${name}.exe`);
  }
  return name;
}

function toolAvailable(name) {
  const probe = spawnSync(tool(name), ['-version'], { encoding: 'utf8', timeout: 30_000 });
  return !probe.error;
}

const javaOk = process.platform === 'win32' && toolAvailable('java') && toolAvailable('javac') && fs.existsSync(jar);

const CREDENTIALS = { username: 'test-operator', password: 'stub-secret' };

let stubUrl = null;
let stubProcess = null;
let buildDir = null;

before(async () => {
  if (!javaOk) return;
  buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-stub-'));
  const compiled = spawnSync(tool('javac'), ['--release', '11', '-encoding', 'UTF-8', '-d', buildDir,
    path.join(rootDir, 'test', 'fixtures', 'stub-jmx', 'StubMgrJmxServer.java')], { encoding: 'utf8', timeout: 120_000 });
  if (compiled.status !== 0) throw new Error(`Stub compilation failed: ${compiled.stderr}`);

  stubProcess = spawn(tool('java'), ['-cp', buildDir, 'StubMgrJmxServer', 'PoolA'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  stubProcess.stderr.on('data', (chunk) => { stderr += chunk; });
  stubUrl = await new Promise((resolve, reject) => {
    let buffered = '';
    const timer = setTimeout(() => reject(new Error(`Stub did not report ready: ${stderr}`)), 30_000);
    stubProcess.stdout.on('data', (chunk) => {
      buffered += chunk;
      const line = buffered.split(/\r?\n/).find((entry) => entry.startsWith('READY '));
      if (line) {
        clearTimeout(timer);
        resolve(line.slice('READY '.length).trim());
      }
    });
    stubProcess.on('close', (code) => { clearTimeout(timer); reject(new Error(`Stub exited (${code}): ${stderr}`)); });
  });
});

after(() => {
  if (stubProcess) stubProcess.kill();
  if (buildDir) fs.rmSync(buildDir, { recursive: true, force: true });
});

function targets() {
  return [{ key: 'stub-manager-01', name: 'Stub Server Manager', managerId: 'PoolA', jmxUrl: stubUrl }];
}

test('adapter chain reads manager status attributes', { skip: !javaOk }, async () => {
  const result = await runJsonCommand(adapter, [], { operation: 'status', ...CREDENTIALS, targets: targets() }, 60_000);
  assert.equal(result.statuses.length, 1);
  assert.equal(result.failures.length, 0);
  const { targetKey, managerId, attributes } = result.statuses[0];
  assert.equal(targetKey, 'stub-manager-01');
  assert.equal(managerId, 'PoolA');
  assert.equal(attributes['Number of Servers'], '3');
  assert.equal(attributes['Number of Assigned Servers'], '2');
  assert.equal(attributes['Number of Warm Servers'], '1');
  assert.equal(attributes['Number of Warming Up Servers'], '0');
  assert.equal(attributes['Servers in Edit Mode'], '0');
  assert.equal(attributes['Servers in Read Mode'], '1');
  assert.equal(attributes['Servers in Stateless Mode'], '1');
  assert.equal(attributes['Number of Servers Terminated Before Normal Timeout'], '0');
  assert.equal(attributes['Number of Cold Servers'], '0');
  assert.equal(attributes['Host'], 'STUBHOST-01');
  assert.equal(attributes['Active Status'], 'true');
  assert.equal(attributes['Assignment Service'], 'http://STUBHOST-01:8086/PoolA');
  assert.equal(attributes['Mux'], 'http://STUBHOST-01:8087');
  assert.match(attributes['Last Restart Warm Servers Time'], /2026|20\d\d/);
});

test('adapter chain invokes Restart_Warm_Servers and values change', { skip: !javaOk }, async () => {
  const result = await runJsonCommand(adapter, [], { operation: 'restart-warm', ...CREDENTIALS, targets: targets(), targetKey: 'stub-manager-01' }, 60_000);
  assert.equal(result.restarted, true);
  assert.equal(result.targetKey, 'stub-manager-01');

  const refreshed = await runJsonCommand(adapter, [], { operation: 'status', ...CREDENTIALS, targets: targets() }, 60_000);
  assert.equal(refreshed.statuses[0].attributes['Number of Warm Servers'], '3');
  assert.notEqual(refreshed.statuses[0].attributes['Last Restart Warm Servers Time'], 'Mon Oct 05 19:27:15 CST 2026');
});

test('adapter chain rejects wrong credentials', { skip: !javaOk }, async () => {
  // Status failures are per-target, so a rejected login surfaces in failures
  // while the call itself still resolves.
  const result = await runJsonCommand(adapter, [], { operation: 'status', username: 'test-operator', password: 'wrong', targets: targets() }, 60_000);
  assert.equal(result.statuses.length, 0);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].error, /SecurityException|Authentication failed/);
});

test('adapter chain lists stub processes with encoded unique ids', { skip: !javaOk }, async () => {
  const result = await runJsonCommand(adapter, [], { operation: 'list', ...CREDENTIALS, targets: targets() }, 60_000);
  assert.equal(result.failures.length, 0);
  assert.equal(result.processes.length, 2);
  const first = result.processes.find((item) => item.serverId === 'tcserver00158@PoolA@4144@STUBHOST-01');
  assert.match(first.id, /^stub-manager-01:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
  assert.equal(first.pool, 'PoolA');
  assert.equal(first.pid, '9496');
  assert.equal(first.owner, 'infodba');
  assert.equal(first.lifecycle, 'Assigned');
  assert.equal(first.mode, 'Read');
  assert.equal(first.status, 'Idle');
  assert.equal(first.host, 'localhost');
  assert.ok(first.durationSeconds >= 60);
  const second = result.processes.find((item) => item.serverId === 'tcserver00313@PoolA@4144@STUBHOST-01');
  assert.equal(second.lifecycle, 'Assigned');
  assert.equal(second.mode, 'Stateless');
  assert.equal(second.status, 'Idle');
});

test('adapter chain terminates a process and it disappears', { skip: !javaOk }, async () => {
  const listed = await runJsonCommand(adapter, [], { operation: 'list', ...CREDENTIALS, targets: targets() }, 60_000);
  const first = listed.processes.find((item) => item.serverId === 'tcserver00158@PoolA@4144@STUBHOST-01');
  const result = await runJsonCommand(adapter, [], {
    operation: 'terminate', ...CREDENTIALS, targets: targets(), targetKey: 'stub-manager-01', serverId: first.serverId
  }, 60_000);
  assert.equal(result.terminated, true);

  const refreshed = await runJsonCommand(adapter, [], { operation: 'list', ...CREDENTIALS, targets: targets() }, 60_000);
  assert.equal(refreshed.processes.length, 1);
  assert.equal(refreshed.processes[0].serverId, 'tcserver00313@PoolA@4144@STUBHOST-01');
});

test('adapter chain rejects terminating an unknown serverId', { skip: !javaOk }, async () => {
  await assert.rejects(
    () => runJsonCommand(adapter, [], {
      operation: 'terminate', ...CREDENTIALS, targets: targets(), targetKey: 'stub-manager-01', serverId: 'tcserver99999@PoolA@1@STUBHOST-01'
    }, 60_000),
    /not found|IllegalState/i
  );
});

test('adapter chain manages a server: logging / log levels / journal modules', { skip: !javaOk }, async () => {
  const serverId = 'tcserver00313@PoolA@4144@STUBHOST-01';
  const base = { operation: 'server-manage', ...CREDENTIALS, targets: targets(), targetKey: 'stub-manager-01', serverId };

  const status = await runJsonCommand(adapter, [], { ...base, manageOp: 'server-log-status' }, 60_000);
  assert.equal(status.attributes.find((a) => a.name === 'Checking Level').value, '0');
  assert.equal(status.attributes.find((a) => a.name === 'SQL  Logging Enabled').value, 'false');

  await runJsonCommand(adapter, [], { ...base, manageOp: 'set-sql-logging', arg1: 'true,false,true,false,false' }, 60_000);
  const after = await runJsonCommand(adapter, [], { ...base, manageOp: 'server-log-status' }, 60_000);
  assert.equal(after.attributes.find((a) => a.name === 'SQL  Logging Enabled').value, 'true');
  assert.equal(after.attributes.find((a) => a.name === 'SQL Timing').value, 'false');

  const syslog = await runJsonCommand(adapter, [], { ...base, manageOp: 'show-syslog', arg1: '2000' }, 60_000);
  assert.match(syslog.content, /STUB SYSLOG CONTENT maxKb=2000/);

  const levels = await runJsonCommand(adapter, [], { ...base, manageOp: 'log-levels' }, 60_000);
  const soap = levels.loggers.find((l) => l.name === 'Teamcenter.Soap');
  assert.equal(soap.priority, 'DEBUG');
  await runJsonCommand(adapter, [], { ...base, manageOp: 'set-log-level', arg1: 'Teamcenter.Soap', arg2: 'WARN' }, 60_000);
  await runJsonCommand(adapter, [], { ...base, manageOp: 'set-log-level', arg1: 'Teamcenter.NewLogger', arg2: 'DEBUG' }, 60_000);
  const levelsAfter = await runJsonCommand(adapter, [], { ...base, manageOp: 'log-levels' }, 60_000);
  assert.equal(levelsAfter.loggers.find((l) => l.name === 'Teamcenter.Soap').priority, 'WARN');
  assert.equal(levelsAfter.loggers.find((l) => l.name === 'Teamcenter.NewLogger').priority, 'DEBUG');

  const modules = await runJsonCommand(adapter, [], { ...base, manageOp: 'journal-modules' }, 60_000);
  assert.equal(modules.modules.find((m) => m.name === 'com.teamcenter.rac.kernel').active, false);
  await runJsonCommand(adapter, [], { ...base, manageOp: 'set-journal-modules', arg1: 'com.teamcenter.rac.kernel=true' }, 60_000);
  const modulesAfter = await runJsonCommand(adapter, [], { ...base, manageOp: 'journal-modules' }, 60_000);
  assert.equal(modulesAfter.modules.find((m) => m.name === 'com.teamcenter.rac.kernel').active, true);
});

test('adapter chain manages monitoring: status / mode / events / history', { skip: !javaOk }, async () => {
  const serverId = 'tcserver00313@PoolA@4144@STUBHOST-01';
  const base = { operation: 'server-manage', ...CREDENTIALS, targets: targets(), targetKey: 'stub-manager-01', serverId };

  const status = await runJsonCommand(adapter, [], { ...base, manageOp: 'monitoring-status' }, 60_000);
  assert.equal(status.monitoringMode, 'Off');
  assert.ok(status.metrics.some((m) => m.metricId === 'POMRetries' && m.mode === 'Collect'));
  assert.ok(status.responders.includes('EmailResponder1'));

  await runJsonCommand(adapter, [], { ...base, manageOp: 'set-monitoring-mode', arg1: 'Normal' }, 60_000);
  const after = await runJsonCommand(adapter, [], { ...base, manageOp: 'monitoring-status' }, 60_000);
  assert.equal(after.monitoringMode, 'Normal');

  const events = await runJsonCommand(adapter, [], { ...base, manageOp: 'metric-events', arg1: 'POMRetries', arg2: 'recent' }, 60_000);
  assert.deepEqual(events.events, ['recent event A', 'recent event B']);

  await runJsonCommand(adapter, [], { ...base, manageOp: 'clear-metric-history', arg1: 'POMRetries' }, 60_000);
});

test('adapter chain probe exposes manager domain and attributes', { skip: !javaOk }, async () => {
  const result = await runJsonCommand(adapter, [], { operation: 'probe', ...CREDENTIALS, targets: targets() }, 60_000);
  const report = result.reports[0];
  assert.equal(report.targetKey, 'stub-manager-01');
  assert.ok(report.domains.includes('Administer PoolA manager '));
  assert.ok(report.mbeans.some((mbean) => mbean.objectName.includes('Administer PoolA manager :id=PoolA')));
  assert.ok(report.attributes.some((entry) => entry.name === 'Number of Servers' && entry.value === '3'));
  assert.ok(report.totalMBeans >= 1);
});

test('adapter chain reports per-target failures without losing other targets', { skip: !javaOk }, async () => {
  const mixed = [
    { key: 'dead-manager', name: 'Unreachable', managerId: 'PoolX', jmxUrl: stubUrl },
    { key: 'live-manager', name: 'Stub', managerId: 'PoolA', jmxUrl: stubUrl }
  ];
  const result = await runJsonCommand(adapter, [], { operation: 'status', ...CREDENTIALS, targets: mixed }, 60_000);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].targetKey, 'dead-manager');
  assert.equal(result.statuses.length, 1);
  assert.equal(result.statuses[0].targetKey, 'live-manager');
});

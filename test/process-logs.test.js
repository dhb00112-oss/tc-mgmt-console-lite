// Unit tests for the PM_PROCESS_LIST log-name resolver (demo + off modes and
// the prefix composition rules; the live Oracle path is covered by the opt-in
// oracle-live test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcessLogResolver } from '../src/adapters/process-logs.js';

const PROCESSES = [
  { pid: '9496', pool: 'PoolA', managerId: 'PoolA' },
  { pid: '99999', pool: 'PoolA', managerId: 'PoolA' }
];

test('off mode leaves processes untouched', async () => {
  const resolver = createProcessLogResolver({ mode: 'off' });
  const processes = structuredClone(PROCESSES);
  await resolver.enrich(processes);
  assert.equal(processes[0].logFile, undefined);
});

test('demo mode resolves file names and composes prefix paths', async () => {
  const resolver = createProcessLogResolver({
    mode: 'demo',
    pathPrefixes: { PoolA: 'D:\\Program Files\\Siemens\\logs\\Teamcenter\\ServerManagers\\TcCluster\\PoolA\\TcServer\\process\\' }
  });
  const processes = structuredClone(PROCESSES);
  await resolver.enrich(processes);
  assert.equal(processes[0].logFile, 'tcserver.exe2518e80a.syslog');
  assert.equal(processes[0].logPath, 'D:\\Program Files\\Siemens\\logs\\Teamcenter\\ServerManagers\\TcCluster\\PoolA\\TcServer\\process\\tcserver.exe2518e80a.syslog');
  // Unknown PID: no log name, no fabricated data.
  assert.equal(processes[1].logFile, '');
});

test('without a configured prefix the raw truncated tail is kept', async () => {
  const resolver = createProcessLogResolver({ mode: 'demo', pathPrefixes: {} });
  const processes = structuredClone(PROCESSES);
  await resolver.enrich(processes);
  assert.match(processes[0].logPath, /^\.\.\./);
  assert.match(processes[0].logPath, /TcServer\\process\\tcserver\.exe2518e80a\.syslog$/);
});

test('pool prefix falls back to the manager id key', async () => {
  const resolver = createProcessLogResolver({
    mode: 'demo',
    pathPrefixes: { PoolA: 'D:\\poola-logs' }
  });
  const processes = [{ pid: '9496', pool: 'PoolA', managerId: 'PoolB' }];
  await resolver.enrich(processes);
  assert.ok(processes[0].logPath.startsWith('D:\\poola-logs\\'));
});

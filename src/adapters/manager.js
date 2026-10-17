import { runJsonCommand } from './command.js';

function safePart(value) {
  return Buffer.from(String(value), 'utf8').toString('base64url');
}

// Demo fixtures mirror a real Server Manager console layout
// so the page can be developed and tested without a real Server Manager.
const DEMO_PROCESSES = [
  { serverId: 'tcserver00158@PoolA@4144@DEMO-01', pid: '9496', pool: 'PoolA', host: 'DEMO-01', owner: 'infodba', lifecycle: 'Assigned', mode: 'Read', status: 'Idle', durationSeconds: 12225 },
  { serverId: 'tcserver00313@PoolA@4144@DEMO-01', pid: '5464', pool: 'PoolA', host: 'DEMO-01', owner: 'infodba', lifecycle: 'Assigned', mode: 'Stateless', status: 'Idle', durationSeconds: 28 },
  { serverId: 'tcserver00317@PoolA@4144@DEMO-01', pid: '10176', pool: 'PoolA', host: 'DEMO-01', owner: 'infodba', lifecycle: 'Ready', mode: 'Stateless', status: 'Idle', durationSeconds: 9111 }
];

// Demo state for the per-server Logging / Log Levels / Monitoring fixtures.
const demoServerState = {
  sql: { 'SQL  Logging Enabled': 'false', 'SQL Profile': 'false', 'SQL Show Bind Variables': 'false', 'SQL Timing': 'false', 'SQL To the Journal file': 'false' },
  loggers: [
    { name: 'Teamcenter', priority: 'INFO' },
    { name: 'Teamcenter.BOMManagement', priority: 'INFO*' },
    { name: 'Teamcenter.BOMExpand', priority: 'INFO*' },
    { name: 'Teamcenter.AppModel', priority: 'INFO*' },
    { name: 'Teamcenter.Soap', priority: 'INFO*' }
  ],
  monitoringMode: 'Off',
  metrics: [
    { metricId: 'Summary', mode: 'Collect', dateStarted: '', historical: '0', recent: '0' },
    { metricId: 'POMRetries', mode: 'Collect', dateStarted: '', historical: '0', recent: '0' },
    { metricId: 'DBConnectionLosses', mode: 'Collect', dateStarted: '', historical: '0', recent: '0' },
    { metricId: 'VeryLongRunningQueries', mode: 'Collect', dateStarted: '', historical: '0', recent: '0' },
    { metricId: 'PomLocks', mode: 'Collect', dateStarted: '', historical: '0', recent: '0' },
    { metricId: 'Deadlocks', mode: 'Collect', dateStarted: '', historical: '0', recent: '0' }
  ],
  responders: ['EmailResponder1', 'LoggerResponder1', 'MetricModeController1', 'LogLevelController1'],
  modules: [
    { name: 'com.teamcenter.rac.kernel', active: false },
    { name: 'com.teamcenter.services.loose', active: false }
  ]
};

function demoStatus(target) {
  return {
    targetKey: target.key,
    managerId: target.managerId,
    attributes: {
      'Host': target.name.match(/\(([^:]+):/)?.[1] ?? 'DEMO-HOST',
      'Active Status': 'true',
      'Assignment Service': `http://${target.jmxUrl.replace(/^.*rmi:\/\//, '').replace(/:\d+.*$/, '')}:8086/${target.managerId}`,
      'Mux': `http://${target.jmxUrl.replace(/^.*rmi:\/\//, '').replace(/:\d+.*$/, '')}:8087`,
      'Number of Servers': '3',
      'Number of Assigned Servers': '2',
      'Number of Warm Servers': '1',
      'Number of Warming Up Servers': '0',
      'Number of Cold Servers': '0',
      'Number of Servers Terminated Before Normal Timeout': '0',
      'Servers in Edit Mode': '0',
      'Servers in Read Mode': '1',
      'Servers in Stateless Mode': '1',
      'Last Restart Warm Servers Time': new Date(Date.now() - 2 * 3600_000).toString()
    }
  };
}

export function createManagerAdapter(config) {
  const { command, args = [], timeoutMs, statusCacheMs } = config.adapter;
  const listCacheMs = Number.isFinite(statusCacheMs) ? statusCacheMs : 3000;
  let demoProcesses = DEMO_PROCESSES.map((p) => ({ ...p }));
  let statusCache = { key: '', value: null, expiresAt: 0 };
  let statusInflight = null;
  let listCache = { key: '', value: null, expiresAt: 0 };
  let listInflight = null;

  function call(input) {
    return runJsonCommand(command, args, input, timeoutMs);
  }

  function decorate(target, process) {
    return { ...process, id: `${target.key}:${safePart(process.pool)}:${safePart(process.serverId)}`, targetKey: target.key, managerId: target.managerId };
  }

  async function listStatus(credentials) {
    const targets = config.targets;
    if (config.mode === 'demo') {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return { statuses: targets.map(demoStatus), failures: [] };
    }
    const key = `${credentials.username}|${JSON.stringify(targets)}`;
    const now = Date.now();
    if (statusCache.value && statusCache.key === key && statusCache.expiresAt > now) return statusCache.value;
    if (statusInflight && statusInflight.key === key) return statusInflight.promise;
    const promise = call({ operation: 'status', ...credentials, targets })
      .then((result) => {
        const value = { statuses: result.statuses ?? [], failures: result.failures ?? [] };
        statusCache = { key, value, expiresAt: Date.now() + statusCacheMs };
        return value;
      })
      .finally(() => { statusInflight = null; });
    statusInflight = { key, promise };
    return promise;
  }

  async function restartWarm(credentials, targetKey) {
    const target = config.targets.find((item) => item.key === targetKey);
    if (!target) throw new Error('Unknown target.');
    if (config.mode === 'demo') {
      await new Promise((resolve) => setTimeout(resolve, 400));
      statusCache = { key: '', value: null, expiresAt: 0 };
      return { restarted: true, targetKey };
    }
    const result = await call({ operation: 'restart-warm', ...credentials, targets: [target], targetKey });
    // Restart changes the counters and the last-restart time; drop the cache.
    statusCache = { key: '', value: null, expiresAt: 0 };
    return result;
  }

  async function listProcesses(credentials) {
    const targets = config.targets;
    if (config.mode === 'demo') {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return {
        processes: demoProcesses.map((process) => {
          const target = targets.find((item) => item.key === 'demo-poola') ?? targets[0];
          return decorate(target, process);
        }),
        failures: []
      };
    }
    const key = `${credentials.username}|${JSON.stringify(targets)}`;
    const now = Date.now();
    if (listCache.value && listCache.key === key && listCache.expiresAt > now) return listCache.value;
    if (listInflight && listInflight.key === key) return listInflight.promise;
    const promise = call({ operation: 'list', ...credentials, targets })
      .then((result) => {
        const value = { processes: result.processes ?? [], failures: result.failures ?? [] };
        listCache = { key, value, expiresAt: Date.now() + listCacheMs };
        return value;
      })
      .finally(() => { listInflight = null; });
    listInflight = { key, promise };
    return promise;
  }

  async function terminateProcess(credentials, targetKey, serverId) {
    const target = config.targets.find((item) => item.key === targetKey);
    if (!target) throw new Error('Unknown target.');
    if (config.mode === 'demo') {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const before = demoProcesses.length;
      demoProcesses = demoProcesses.filter((process) => process.serverId !== serverId);
      if (demoProcesses.length === before) throw new Error('Process not found.');
      listCache = { key: '', value: null, expiresAt: 0 };
      return { terminated: true, targetKey, serverId };
    }
    const result = await call({ operation: 'terminate', ...credentials, targets: [target], targetKey, serverId });
    // The process list changes immediately after Shutdown_Server.
    listCache = { key: '', value: null, expiresAt: 0 };
    return result;
  }

  function demoServerManage(manageOp, arg1, arg2) {
    switch (manageOp) {
      case 'server-log-status':
        return {
          attributes: [
            { name: 'Checking Level', value: '0' },
            ...Object.entries(demoServerState.sql).map(([name, value]) => ({ name, value }))
          ]
        };
      case 'set-sql-logging': {
        const flags = String(arg1).split(',');
        const names = Object.keys(demoServerState.sql);
        flags.forEach((flag, index) => { demoServerState.sql[names[index]] = flag === 'true' ? 'true' : 'false'; });
        return { done: true };
      }
      case 'show-syslog':
        return { content: `DEMO syslog for ${arg1} KB:\n2026-10-11 15:27:36 INFO  Teamcenter.ManagementConsole - ping\n2026-10-11 15:27:37 DEBUG Teamcenter.Soap - request handled\n...（模拟内容）` };
      case 'show-journal':
        return { content: 'DEMO journal content（模拟内容）' };
      case 'journal-action':
      case 'stats-action':
        return { done: true };
      case 'journal-modules':
        return { modules: demoServerState.modules.map((m) => ({ ...m })) };
      case 'set-journal-modules': {
        for (const assignment of String(arg1).split('\u001f')) {
          if (!assignment) continue;
          const equals = assignment.lastIndexOf('=');
          const module = demoServerState.modules.find((m) => m.name === assignment.slice(0, equals));
          if (module) module.active = assignment.slice(equals + 1) === 'true';
        }
        return { done: true };
      }
      case 'log-levels':
        return { loggers: demoServerState.loggers.map((l) => ({ ...l })) };
      case 'set-log-level': {
        const logger = demoServerState.loggers.find((l) => l.name === arg1);
        if (logger) logger.priority = arg2 || 'DEFAULT';
        return { done: true };
      }
      case 'monitoring-status':
        return {
          monitoringMode: demoServerState.monitoringMode,
          metrics: demoServerState.metrics.map((m) => ({ ...m })),
          responders: [...demoServerState.responders]
        };
      case 'set-monitoring-mode':
        demoServerState.monitoringMode = arg1;
        return { done: true };
      case 'metric-events':
        return { events: [`DEMO ${arg2} event 1 (metric ${arg1})`, `DEMO ${arg2} event 2`] };
      case 'clear-metric-history':
        for (const metric of demoServerState.metrics) {
          if (arg1 === '__ALL__' || metric.metricId === arg1) { metric.historical = '0'; metric.recent = '0'; }
        }
        return { done: true };
      default:
        throw new Error(`Unsupported demo manage op: ${manageOp}`);
    }
  }

  async function serverManage(credentials, targetKey, serverId, manageOp, arg1 = '', arg2 = '') {
    const target = config.targets.find((item) => item.key === targetKey);
    if (!target) throw new Error('Unknown target.');
    if (config.mode === 'demo') {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return demoServerManage(manageOp, arg1, arg2);
    }
    return call({
      operation: 'server-manage', ...credentials,
      targets: [target], targetKey, serverId, manageOp, arg1, arg2
    });
  }

  function invalidateCaches() {
    statusCache = { key: '', value: null, expiresAt: 0 };
    listCache = { key: '', value: null, expiresAt: 0 };
    statusInflight = null;
    listInflight = null;
  }

  return { listStatus, restartWarm, listProcesses, terminateProcess, serverManage, invalidateCaches };
}

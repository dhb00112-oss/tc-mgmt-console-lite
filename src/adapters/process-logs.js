// Resolves each TC server process's syslog file name from the pool manager's
// PM_PROCESS_LIST table (field-verified on TC 14.2 / Oracle 19c):
//   PM_KEY    = "<8-hex-os-pid>:<8-hex-random> <hostname>"  (hex1 == OS PID)
//   PM_SYSLOG = "...<tail of path>\tcserver.exe<hex-pid><hex-random>.syslog"
// The stored path keeps only the tail (the drive/root is truncated to "..." on
// the server side), so the full path is composed with a per-pool prefix from
// config (processLog.pathPrefixes). oracledb is loaded lazily: the app still
// starts (and the status view works) when the module or the feature is absent.
export function createProcessLogResolver(processLog) {
  const mode = processLog?.mode ?? 'off';
  if (mode === 'off') {
    return { async enrich() {}, async close() {} };
  }

  function prefixFor(poolName, managerId) {
    return processLog.pathPrefixes?.[poolName] ?? processLog.pathPrefixes?.[managerId] ?? '';
  }

  function describe(syslog, prefix) {
    const fileName = String(syslog).split(/[\\/]/).pop() ?? '';
    // The DB tail starts mid-directory ("...ens\\logs\\..."), so the usable
    // display is prefix + file name; the raw tail is kept for verification.
    const fullPath = prefix ? `${prefix.replace(/[\\/]+$/, '')}\\${fileName}` : '';
    return { fileName, rawTail: String(syslog), fullPath };
  }

  function apply(processes, syslogByPid) {
    for (const process of processes) {
      const syslog = syslogByPid.get(String(process.pid).trim());
      if (!syslog) {
        process.logFile = '';
        continue;
      }
      const info = describe(syslog, prefixFor(process.pool, process.managerId));
      process.logFile = info.fileName;
      process.logPath = info.fullPath || info.rawTail;
    }
  }

  if (mode === 'demo') {
    // Fixture mirrors the live values read from the field environment.
    const demoSyslogByPid = new Map([
      ['9496', '...ens\\logs\\Teamcenter\\ServerManagers\\TcCluster\\PoolA\\\\TcServer\\process\\tcserver.exe2518e80a.syslog'],
      ['5464', '...ens\\logs\\Teamcenter\\ServerManagers\\TcCluster\\PoolA\\\\TcServer\\process\\tcserver.exe1558c416.syslog'],
      ['10176', '...ens\\logs\\Teamcenter\\ServerManagers\\TcCluster\\PoolA\\\\TcServer\\process\\tcserver.exe27c0a1fe.syslog']
    ]);
    return {
      async enrich(processes) {
        apply(processes, demoSyslogByPid);
      },
      // On-demand lookup for a single process (used by the per-row 日志 button).
      async lookup(pid, poolName, managerIdValue) {
        const syslog = demoSyslogByPid.get(String(pid).trim());
        if (!syslog) return { logFile: '', logPath: '', rawTail: '' };
        const info = describe(syslog, prefixFor(poolName, managerIdValue));
        return { logFile: info.fileName, logPath: info.fullPath || info.rawTail, rawTail: info.rawTail };
      },
      async close() {}
    };
  }

  // mode === 'oracle'
  let pool = null;
  let poolPromise = null;

  async function getPool() {
    if (pool) return pool;
    if (!poolPromise) {
      poolPromise = (async () => {
        const module = await import('oracledb');
        const oracledb = module.default ?? module;
        const password = process.env[processLog.oracle.passwordEnv];
        if (!password) throw new Error(`Environment variable ${processLog.oracle.passwordEnv} is not set (Oracle password).`);
        return oracledb.createPool({
          user: processLog.oracle.user,
          password,
          connectString: processLog.oracle.connectString,
          poolMin: 0,
          poolMax: 4,
          poolTimeout: 60
        });
      })();
      pool = await poolPromise;
    }
    return pool;
  }

  // One bounded query per refresh; the table holds one row per process start.
  async function syslogByPid() {
    const poolHandle = await getPool();
    const connection = await poolHandle.getConnection();
    try {
      const result = await connection.execute(
        'SELECT pm_key, pm_syslog FROM pm_process_list',
        [],
        { maxRows: 5000 }
      );
      const map = new Map();
      for (const [key, syslog] of result.rows) {
        const text = String(key ?? '');
        const hexPid = parseInt(text.split(':')[0], 16);
        if (Number.isFinite(hexPid) && syslog) map.set(String(hexPid), String(syslog));
      }
      return map;
    } finally {
      await connection.close();
    }
  }

  return {
    async enrich(processes) {
      if (processes.length === 0) return;
      let map;
      try {
        map = await syslogByPid();
      } catch (error) {
        // Log resolution must never hide the process list itself.
        const reason = String(error.message).split('\n')[0].slice(0, 200);
        for (const process of processes) process.logError = reason;
        return;
      }
      apply(processes, map);
    },

    // On-demand lookup for a single process (used by the per-row 日志 button);
    // the caller passes the JMX Process ID and the pool/manager names.
    async lookup(pid, poolName, managerIdValue) {
      let map;
      try {
        map = await syslogByPid();
      } catch (error) {
        throw new Error(String(error.message).split('\n')[0].slice(0, 200));
      }
      const syslog = map.get(String(pid).trim());
      if (!syslog) return { logFile: '', logPath: '', rawTail: '' };
      const info = describe(syslog, prefixFor(poolName, managerIdValue));
      return { logFile: info.fileName, logPath: info.fullPath || info.rawTail, rawTail: info.rawTail };
    },

    async close() {
      if (pool) await pool.close(0);
      pool = null;
      poolPromise = null;
    }
  };
}

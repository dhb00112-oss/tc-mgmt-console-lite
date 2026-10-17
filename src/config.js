import fs from 'node:fs';
import path from 'node:path';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function loadConfig() {
  const production = process.env.NODE_ENV === 'production';
  const file = process.env.APP_CONFIG
    ? path.resolve(process.env.APP_CONFIG)
    : path.resolve('config.json');
  const raw = fs.existsSync(file) ? readJson(file) : {};
  const configDirectory = path.dirname(file);

  const mode = raw.mode ?? 'demo';
  if (!['demo', 'command'].includes(mode)) throw new Error('mode must be "demo" or "command".');

  const adapter = {
    command: raw.adapter?.command ?? 'adapters\\tc-mgr-adapter.cmd',
    args: Array.isArray(raw.adapter?.args) ? raw.adapter.args.map(String) : [],
    timeoutMs: Number(raw.adapter?.timeoutMs ?? 30_000),
    statusCacheMs: Number(raw.adapter?.statusCacheMs ?? 3_000)
  };
  if (!Number.isFinite(adapter.timeoutMs) || adapter.timeoutMs < 1_000 || adapter.timeoutMs > 120_000) {
    throw new Error('adapter.timeoutMs must be between 1000 and 120000.');
  }
  if (!Number.isFinite(adapter.statusCacheMs) || adapter.statusCacheMs < 0 || adapter.statusCacheMs > 60_000) {
    throw new Error('adapter.statusCacheMs must be between 0 and 60000.');
  }

  const targets = Array.isArray(raw.targets) ? raw.targets : [];
  const keys = new Set();
  for (const target of targets) {
    if (typeof target.key !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(target.key)) {
      throw new Error(`Invalid target key: ${target.key}`);
    }
    if (keys.has(target.key)) throw new Error(`Duplicate target key: ${target.key}`);
    keys.add(target.key);
    for (const field of ['name', 'managerId', 'jmxUrl']) {
      if (typeof target[field] !== 'string' || !target[field].trim()) {
        throw new Error(`Target ${target.key} is missing a valid ${field}.`);
      }
    }
  }
  if (mode === 'command' && targets.length === 0) {
    throw new Error('mode=command requires at least one configured target.');
  }

  const processLog = {
    mode: raw.processLog?.mode ?? 'off',
    oracle: {
      user: String(raw.processLog?.oracle?.user ?? 'infodba'),
      passwordEnv: String(raw.processLog?.oracle?.passwordEnv ?? 'TC_DB_PASSWORD'),
      connectString: String(raw.processLog?.oracle?.connectString ?? '')
    },
    pathPrefixes: raw.processLog?.pathPrefixes && typeof raw.processLog.pathPrefixes === 'object'
      ? Object.fromEntries(Object.entries(raw.processLog.pathPrefixes).map(([k, v]) => [String(k), String(v)]))
      : {}
  };
  if (!['off', 'demo', 'oracle'].includes(processLog.mode)) {
    throw new Error('processLog.mode must be "off", "demo" or "oracle".');
  }
  if (processLog.mode === 'oracle' && !processLog.oracle.connectString) {
    throw new Error('processLog.mode=oracle requires processLog.oracle.connectString (host:port/service_name).');
  }

  const config = {
    listenHost: raw.listenHost ?? '127.0.0.1',
    listenPort: Number(raw.listenPort ?? 8095),
    publicBaseUrl: raw.publicBaseUrl ?? 'http://127.0.0.1:8095',
    sessionMinutes: Number(raw.sessionMinutes ?? 15),
    mode,
    demoLogin: {
      username: String(raw.demoLogin?.username ?? 'demo'),
      password: String(raw.demoLogin?.password ?? 'demo')
    },
    adapter,
    processLog: {
      ...processLog,
      // Demo application mode always uses fabricated log data.
      mode: mode === 'demo' && processLog.mode === 'oracle' ? 'demo' : processLog.mode
    },
    audit: {
      enabled: Boolean(raw.audit?.enabled ?? true),
      logPath: path.resolve(configDirectory, raw.audit?.logPath ?? 'logs/audit-{date}.jsonl'),
      // Resolved against the config directory (not logPath's parent) so the
      // summary lives beside the JSONL file instead of in a nested logs/logs/.
      summaryPath: path.resolve(configDirectory, raw.audit?.summaryPath ?? 'logs/audit-summary-{date}.log'),
      reverseDns: Boolean(raw.audit?.reverseDns ?? true),
      trustedProxies: Array.isArray(raw.audit?.trustedProxies) ? raw.audit.trustedProxies.map(String) : []
    },
    tls: {
      enabled: Boolean(raw.tls?.enabled ?? false),
      keyPath: raw.tls?.keyPath ?? '',
      certPath: raw.tls?.certPath ?? '',
      caPath: raw.tls?.caPath ?? ''
    },
    targets
  };

  if (production && config.mode === 'demo') {
    throw new Error('Production refuses demo mode. Set mode=command in config.json.');
  }
  if (mode === 'command' && !adapter.command) {
    throw new Error('mode=command requires adapter.command.');
  }
  if (config.tls.enabled && (!config.tls.keyPath || !config.tls.certPath)) {
    throw new Error('TLS requires tls.keyPath and tls.certPath.');
  }
  if (config.tls.enabled && !config.publicBaseUrl.startsWith('https://')) {
    throw new Error('publicBaseUrl must use https:// when TLS is enabled.');
  }
  if (!Number.isInteger(config.listenPort) || config.listenPort < 1 || config.listenPort > 65535) {
    throw new Error('listenPort must be a valid TCP port.');
  }
  if (!Number.isFinite(config.sessionMinutes) || config.sessionMinutes < 1 || config.sessionMinutes > 120) {
    throw new Error('sessionMinutes must be between 1 and 120.');
  }
  return config;
}

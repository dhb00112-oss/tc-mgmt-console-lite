import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export function normalizeIp(value) {
  const text = String(value ?? '').trim();
  return text.startsWith('::ffff:') ? text.slice(7) : text;
}

export function requestIp(req, trustedProxies = []) {
  const remoteIp = normalizeIp(req.socket?.remoteAddress);
  const trusted = trustedProxies.map(normalizeIp).includes(remoteIp);
  if (!trusted) return remoteIp || 'unknown';

  const forwarded = String(req.headers?.['x-forwarded-for'] ?? '').split(',')[0].trim();
  const candidate = normalizeIp(forwarded);
  return net.isIP(candidate) ? candidate : (remoteIp || 'unknown');
}

// Human-readable console summaries, one line per audit record, for operators
// watching the service window. Passwords never appear in any field.
const READABLE_SUMMARIES = {
  login_success: (f) => `登录成功：用户 ${f.userId}（来源 ${f.clientIp}${f.computerName ? `，计算机名 ${f.computerName}` : ''}${f.authTarget ? `，验证目标 ${f.authTarget}` : ''}）`,
  login_failed: (f) => `登录失败：账号 ${f.attemptedUserId}（来源 ${f.clientIp}）${f.error ? `：${f.error}` : ''}`,
  login_rate_limited: (f) => `登录限流：来源 ${f.clientIp} 尝试过于频繁`,
  logout: (f) => `退出登录：用户 ${f.userId}`,
  status_viewed: (f) => `查看状态：用户 ${f.userId} 获取了 ${f.targets ?? 0} 个 Server Manager 的状态`,
  restart_warm_requested: (f) => `重启Warm请求：用户 ${f.userId} 请求重启 ${f.managerId}（${f.targetKey}）的 Warm 服务器`,
  restart_warm_succeeded: (f) => `重启Warm成功：用户 ${f.userId} 重启了 ${f.managerId}（${f.targetKey}）的 Warm 服务器`,
  restart_warm_failed: (f) => `重启Warm失败：用户 ${f.userId} 重启 ${f.managerId}（${f.targetKey}）失败：${f.error}`,
  processes_viewed: (f) => `查看进程：用户 ${f.userId} 获取了 ${f.processes} 个进程的列表`,
  process_cleanup_requested: (f) => `清理请求：用户 ${f.userId} 请求清理 PID ${f.pid}（服务器 ${f.serverId}，池 ${f.pool}，属主 ${f.processOwner || '无'}）`,
  process_cleanup_succeeded: (f) => `清理成功：用户 ${f.userId} 清理了 PID ${f.pid}（服务器 ${f.serverId}，池 ${f.pool}）`,
  process_cleanup_failed: (f) => `清理失败：用户 ${f.userId} 清理 PID ${f.pid}（服务器 ${f.serverId}，池 ${f.pool}）失败：${f.error}`,
  process_cleanup_batch: (f) => `批量清理完成：用户 ${f.userId} 成功清理 ${f.succeeded} 个进程（PID：${(f.pids ?? []).join(', ') || '无'}），失败 ${f.failed} 个`,
  process_manage_show_syslog: (f) => `查看Syslog：用户 ${f.userId} 查看了 ${f.serverId} 的 syslog（上限 ${f.arg1} KB）`,
  process_manage_show_journal: (f) => `查看Journal：用户 ${f.userId} 查看了 ${f.serverId} 的 journal（上限 ${f.arg1} KB）`,
  process_manage_set_sql_logging: (f) => `SQL日志设置：用户 ${f.userId} 将 ${f.serverId} 的 SQL 日志开关改为 ${f.arg1}`,
  process_manage_journal_action: (f) => `Journal操作：用户 ${f.userId} 对 ${f.serverId} 执行 ${f.arg1}${f.arg2 ? `（${f.arg2}）` : ''}`,
  process_manage_stats_action: (f) => `统计操作：用户 ${f.userId} 对 ${f.serverId} 执行 ${f.arg1}`,
  process_manage_set_journal_modules: (f) => `模块Journal设置：用户 ${f.userId} 修改了 ${f.serverId} 的模块开关`,
  process_manage_set_log_level: (f) => `日志级别：用户 ${f.userId} 将 ${f.serverId} 的 ${f.arg1} 设为 ${f.arg2 || 'DEFAULT'}`,
  process_manage_set_monitoring_mode: (f) => `监控模式：用户 ${f.userId} 将 ${f.serverId} 的主监控模式设为 ${f.arg1}`,
  process_manage_clear_metric_history: (f) => `清除历史：用户 ${f.userId} 清除了 ${f.serverId} 的 ${f.arg1 === '__ALL__' ? '全部指标' : f.arg1} 事件历史`
};

export class AuditLogger {
  constructor(config) {
    this.enabled = config.enabled;
    this.logPath = config.logPath;
    this.dailyLog = this.logPath.includes('{date}');
    this.summaryPath = config.summaryPath
      ? path.resolve(path.dirname(config.logPath), config.summaryPath)
      : path.join(path.dirname(config.logPath), 'audit-summary-{date}.log');
    this.reverseDns = config.reverseDns;
    this.trustedProxies = config.trustedProxies;
    this.dnsCache = new Map();
    if (this.enabled) {
      fs.mkdirSync(path.dirname(this.logPath.replace('{date}', '1970-01-01')), { recursive: true });
      fs.closeSync(fs.openSync(this.resolveLogFile(new Date()), 'a'));
      fs.mkdirSync(path.dirname(this.summaryPath.replace('{date}', '1970-01-01')), { recursive: true });
    }
  }

  resolveLogFile(now) {
    return this.dailyLog ? this.logPath.replace('{date}', now.toLocaleDateString('sv-SE')) : this.logPath;
  }

  async client(req) {
    const clientIp = requestIp(req, this.trustedProxies);
    if (!this.reverseDns || !net.isIP(clientIp)) {
      return { clientIp, computerName: null, dnsName: null };
    }

    const cached = this.dnsCache.get(clientIp);
    if (cached && cached.expiresAt > Date.now()) return { clientIp, ...cached.value };

    let dnsName = null;
    try {
      const names = await Promise.race([
        dns.reverse(clientIp),
        new Promise((_, reject) => setTimeout(() => reject(new Error('DNS timeout')), 1500))
      ]);
      dnsName = names[0] ?? null;
    } catch {
      dnsName = null;
    }
    const value = {
      computerName: dnsName ? dnsName.split('.')[0] : null,
      dnsName
    };
    this.dnsCache.set(clientIp, { value, expiresAt: Date.now() + 10 * 60_000 });
    return { clientIp, ...value };
  }

  record(event, fields = {}) {
    if (!this.enabled) return;
    const now = new Date();
    const entry = { at: now.toISOString(), event, ...fields };
    fs.appendFileSync(this.resolveLogFile(now), `${JSON.stringify(entry)}\n`, { encoding: 'utf8' });
    const describe = READABLE_SUMMARIES[event];
    const line = `[${now.toLocaleString('sv-SE')}] ${describe ? describe(entry) : `${event}：${JSON.stringify(fields)}`}`;
    try {
      const summaryFile = this.summaryPath.includes('{date}')
        ? this.summaryPath.replace('{date}', now.toLocaleDateString('sv-SE'))
        : this.summaryPath;
      fs.appendFileSync(summaryFile, `${line}\n`, { encoding: 'utf8' });
    } catch (error) {
      console.warn(`Unable to append audit summary: ${error.message}`);
    }
  }
}

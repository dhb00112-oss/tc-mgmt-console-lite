/* Console-lite front end: login with Server Manager credentials, then show
   per-Server-Manager cards with the same two blocks the original console had
   (server-type counts + miscellaneous properties) and a Restart Warm Servers
   action. No frameworks, CSP allows 'self' scripts only. */
'use strict';

const state = { userId: '', csrf: '', demo: false };

const el = (id) => document.getElementById(id);

function show(view) {
  el('login-view').classList.toggle('hidden', view !== 'login');
  el('main-view').classList.toggle('hidden', view !== 'main');
}

function toast(message, isError) {
  const node = el('toast');
  node.textContent = message;
  node.classList.toggle('error', Boolean(isError));
  node.classList.remove('hidden');
  clearTimeout(node._timer);
  node._timer = setTimeout(() => node.classList.add('hidden'), 3200);
}

async function api(pathname, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['X-CSRF-Token'] = state.csrf;
  }
  const response = await fetch(pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return data;
}

/* ---------- login / logout ---------- */

el('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = el('login-button');
  const username = el('login-username').value.trim();
  const password = el('login-password').value;
  el('login-error').classList.add('hidden');
  if (!username || !password) {
    el('login-error').textContent = '请输入账号和密码';
    el('login-error').classList.remove('hidden');
    return;
  }
  button.disabled = true;
  button.textContent = '正在登录…';
  try {
    const data = await api('/api/login', { method: 'POST', body: { username, password } });
    state.userId = data.userId;
    state.csrf = data.csrf;
    state.demo = Boolean(data.demo);
    el('current-user').textContent = username;
    el('demo-badge').classList.toggle('hidden', !state.demo);
    el('login-password').value = '';
    show('main');
    await loadStatus();
  } catch (error) {
    el('login-error').textContent = error.message;
    el('login-error').classList.remove('hidden');
  } finally {
    button.disabled = false;
    button.textContent = '登 录';
  }
});

el('logout-button').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST', body: {} }); } catch { /* session already gone */ }
  show('login');
  el('targets').innerHTML = '';
});

/* ---------- status cards ---------- */

const COUNT_ROWS = [
  ['Total', 'Number of Servers'],
  ['Assigned', 'Number of Assigned Servers'],
  ['Warm', 'Number of Warm Servers'],
  ['Warming Up:', 'Number of Warming Up Servers'],
  ['Edit Mode:', 'Servers in Edit Mode'],
  ['Read Mode:', 'Servers in Read Mode'],
  ['Stateless Mode:', 'Servers in Stateless Mode'],
  ['Terminated Before Normal Timeout:', 'Number of Servers Terminated Before Normal Timeout'],
  ['Cold:', 'Number of Cold Servers']
];

const MISC_ROWS = [
  ['Host Machine:', 'Host'],
  ['Active Status:', 'Active Status'],
  ['Last Restart Warm Servers Time:', 'Last Restart Warm Servers Time'],
  ['Assignment Service:', 'Assignment Service'],
  ['Mux:', 'Mux']
];

function kvBlock(title, rows, attributes) {
  const block = document.createElement('div');
  const heading = document.createElement('h3');
  heading.textContent = title;
  const list = document.createElement('dl');
  list.className = 'kv';
  for (const [label, key] of rows) {
    const row = document.createElement('div');
    const name = document.createElement('dt');
    name.textContent = label;
    const value = document.createElement('dd');
    value.textContent = attributes[key] ?? '';
    row.append(name, value);
    list.append(row);
  }
  block.append(heading, list);
  return block;
}

function buildCard(target) {
  const card = document.createElement('section');
  card.className = 'card';
  card.dataset.key = target.key;

  const head = document.createElement('div');
  head.className = 'card-head';
  const dot = document.createElement('span');
  dot.className = 'dot';
  const title = document.createElement('h2');
  title.textContent = target.name;
  head.append(dot, title);

  const error = document.createElement('p');
  error.className = 'card-error hidden';

  const actions = document.createElement('div');
  actions.className = 'actions';
  const refresh = document.createElement('button');
  refresh.className = 'btn';
  refresh.textContent = 'Refresh';
  refresh.addEventListener('click', () => loadStatus());
  const restart = document.createElement('button');
  restart.className = 'btn primary';
  restart.textContent = 'Restart Warm Servers';
  restart.addEventListener('click', () => confirmRestart(target, restart));
  actions.append(refresh, restart);

  card.append(head, error, actions);
  return { card, dot, error };
}

function renderStatus(payload) {
  const container = el('targets');
  const byKey = new Map();
  for (const card of [...container.children]) byKey.set(card.dataset.key, card);
  container.innerHTML = '';

  for (const target of payload.targets) {
    const { card, dot, error } = buildCard(target);
    const failure = payload.failures.find((item) => item.targetKey === target.key);
    const status = payload.statuses.find((item) => item.targetKey === target.key);
    if (status) {
      dot.classList.add('ok');
      card.insertBefore(kvBlock('Counts of various server types:', COUNT_ROWS, status.attributes), card.querySelector('.actions'));
      card.insertBefore(kvBlock('Other miscellaneous properties:', MISC_ROWS, status.attributes), card.querySelector('.actions'));
    } else {
      dot.classList.add('bad');
      error.textContent = `获取状态失败：${failure?.error ?? '未知原因'}`;
      error.classList.remove('hidden');
    }
    container.append(card);
  }
}

async function loadStatus() {
  const container = el('targets');
  if (!container.children.length) {
    container.innerHTML = '<div class="loading">正在获取 Server Manager 状态…</div>';
  }
  try {
    const payload = await api('/api/status');
    renderStatus(payload);
  } catch (error) {
    if (error.status === 401) {
      show('login');
      return;
    }
    container.innerHTML = `<div class="loading">${error.message}</div>`;
  }
}

/* ---------- restart warm servers ---------- */

function confirmRestart(target, button) {
  openConfirm('Restart Warm Servers', `确定要重启 ${target.name} 的 Warm 服务器吗？所有 Warm 状态的进程将被重启。`, async () => {
    button.disabled = true;
    button.textContent = '正在重启…';
    try {
      await api('/api/operation/restart-warm', { method: 'POST', body: { targetKey: target.key } });
      toast('已发送 Restart Warm Servers 命令');
      setTimeout(loadStatus, 800);
    } catch (error) {
      if (error.status === 401) { show('login'); return; }
      toast(error.message, true);
    } finally {
      button.disabled = false;
      button.textContent = 'Restart Warm Servers';
    }
  });
}

/* ---------- tabs ---------- */

function switchTab(tab) {
  const status = tab === 'status';
  el('tab-status').classList.toggle('active', status);
  el('tab-processes').classList.toggle('active', !status);
  el('status-view').classList.toggle('hidden', !status);
  el('processes-view').classList.toggle('hidden', status);
  if (status) loadStatus();
  else loadProcesses();
}

el('tab-status').addEventListener('click', () => switchTab('status'));
el('tab-processes').addEventListener('click', () => switchTab('processes'));
el('processes-refresh').addEventListener('click', () => loadProcesses());

/* ---------- process tables ---------- */

const PROCESS_COLUMNS = ['Server', 'PID', 'Lifecycle', 'User', 'Mode', 'Status', 'Duration(sec)'];

let processPayload = null;
let selectedIds = new Set();
let processFilter = '';

function matchesFilter(process, filter) {
  if (!filter) return true;
  return [process.serverId, process.pid, process.owner, process.mode, process.status, process.lifecycle, process.pool, process.logFile]
    .some((value) => String(value ?? '').toLowerCase().includes(filter));
}

function updateBatchButtons() {
  const loaded = new Set((processPayload?.processes ?? []).map((item) => item.id));
  const selected = [...selectedIds].filter((id) => loaded.has(id));
  const button = el('terminate-selected');
  button.textContent = `批量清理选中（${selected.length}）`;
  button.disabled = selected.length === 0;
}

function processRow(process) {
  const row = document.createElement('tr');
  const checkCell = document.createElement('td');
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.checked = selectedIds.has(process.id);
  check.addEventListener('change', () => {
    if (check.checked) selectedIds.add(process.id);
    else selectedIds.delete(process.id);
    updateBatchButtons();
  });
  checkCell.append(check);
  row.append(checkCell);

  const cells = [
    process.serverId,
    process.pid,
    process.lifecycle,
    process.owner,
    process.mode,
    process.status,
    String(process.durationSeconds)
  ];
  cells.forEach((text, index) => {
    const cell = document.createElement('td');
    cell.textContent = text;
    if (index === 0) cell.className = 'mono';
    row.append(cell);
  });
  const actionCell = document.createElement('td');
  actionCell.className = 'nowrap';
  const logButton = document.createElement('button');
  logButton.className = 'btn small';
  logButton.textContent = '日志';
  logButton.title = '查询该进程的 syslog 文件路径';
  logButton.addEventListener('click', () => showLogPath(process, logButton));
  const manageButton = document.createElement('button');
  manageButton.className = 'btn small';
  manageButton.textContent = '管理';
  manageButton.title = 'Logging / Log Levels / Monitoring';
  manageButton.addEventListener('click', () => openManage(process));
  const kill = document.createElement('button');
  kill.className = 'btn danger small';
  kill.textContent = '清理';
  kill.addEventListener('click', () => {
    openConfirm('清理进程', `确定要清理进程 ${process.serverId}（PID ${process.pid}，属主 ${process.owner || '无'}）吗？`, async () => {
      kill.disabled = true;
      try {
        await api('/api/processes/terminate', { method: 'POST', body: { targetKey: process.targetKey, id: process.id } });
        toast(`已发送清理命令（PID ${process.pid}）`);
        selectedIds.delete(process.id);
        setTimeout(loadProcesses, 800);
      } catch (error) {
        if (error.status === 401) { show('login'); return; }
        toast(error.message, true);
        kill.disabled = false;
      }
    });
  });
  actionCell.append(logButton, manageButton, kill);
  row.append(actionCell);
  return row;
}

function renderProcesses() {
  const container = el('process-tables');
  const payload = processPayload;
  if (!payload) return;
  container.innerHTML = '';
  for (const target of payload.targets) {
    const failure = payload.failures.find((item) => item.targetKey === target.key);
    const processes = payload.processes
      .filter((item) => item.targetKey === target.key)
      .filter((item) => matchesFilter(item, processFilter));
    const section = document.createElement('section');
    section.className = 'card wide';
    const head = document.createElement('div');
    head.className = 'card-head';
    const title = document.createElement('h2');
    title.textContent = `${target.name}（${processes.length} 个进程${processFilter ? '，筛选后' : ''}）`;
    head.append(title);
    section.append(head);
    if (failure) {
      const error = document.createElement('p');
      error.className = 'card-error';
      error.textContent = `获取进程列表失败：${failure.error}`;
      section.append(error);
      container.append(section);
      continue;
    }
    const table = document.createElement('table');
    table.className = 'process-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    const checkHead = document.createElement('th');
    const selectAll = document.createElement('input');
    selectAll.type = 'checkbox';
    selectAll.title = '全选（当前筛选结果）';
    selectAll.checked = processes.length > 0 && processes.every((item) => selectedIds.has(item.id));
    selectAll.addEventListener('change', () => {
      for (const item of processes) {
        if (selectAll.checked) selectedIds.add(item.id);
        else selectedIds.delete(item.id);
      }
      renderProcesses();
    });
    checkHead.append(selectAll);
    headRow.append(checkHead);
    for (const name of [...PROCESS_COLUMNS, '操作']) {
      const th = document.createElement('th');
      th.textContent = name;
      headRow.append(th);
    }
    thead.append(headRow);
    table.append(thead);
    const tbody = document.createElement('tbody');
    for (const process of processes) tbody.append(processRow(process));
    table.append(tbody);
    section.append(table);
    if (processes.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = processFilter ? '没有匹配搜索条件的进程。' : '当前没有进程。';
      section.append(empty);
    }
    container.append(section);
  }
  updateBatchButtons();
}

async function loadProcesses() {
  const container = el('process-tables');
  if (!container.children.length) {
    container.innerHTML = '<div class="loading">正在获取进程列表…</div>';
  }
  try {
    processPayload = await api('/api/processes');
    // Drop selections for processes that no longer exist.
    const loaded = new Set(processPayload.processes.map((item) => item.id));
    for (const id of [...selectedIds]) {
      if (!loaded.has(id)) selectedIds.delete(id);
    }
    renderProcesses();
  } catch (error) {
    if (error.status === 401) {
      show('login');
      return;
    }
    container.innerHTML = `<div class="loading">${error.message}</div>`;
  }
}

async function batchTerminate(ids) {
  const selectedButton = el('terminate-selected');
  const allButton = el('terminate-all');
  selectedButton.disabled = true;
  allButton.disabled = true;
  try {
    const data = await api('/api/processes/terminate-batch', { method: 'POST', body: { ids } });
    const ok = data.results.filter((entry) => entry.terminated).length;
    const failed = data.results.length - ok;
    if (failed > 0) toast(`清理完成：成功 ${ok} 个，失败 ${failed} 个`, true);
    else toast(`已成功清理 ${ok} 个进程`);
    selectedIds.clear();
    setTimeout(loadProcesses, 800);
  } catch (error) {
    if (error.status === 401) { show('login'); return; }
    toast(error.message, true);
  } finally {
    selectedButton.disabled = false;
    allButton.disabled = false;
    updateBatchButtons();
  }
}

el('process-search').addEventListener('input', (event) => {
  processFilter = event.target.value.trim().toLowerCase();
  renderProcesses();
});

el('terminate-selected').addEventListener('click', () => {
  const loaded = new Set((processPayload?.processes ?? []).map((item) => item.id));
  const ids = [...selectedIds].filter((id) => loaded.has(id));
  if (ids.length === 0) return;
  openConfirm('批量清理选中', `确定要批量清理选中的 ${ids.length} 个进程吗？`, () => batchTerminate(ids));
});

el('terminate-all').addEventListener('click', () => {
  const processes = (processPayload?.processes ?? []).filter((item) => matchesFilter(item, processFilter));
  if (processes.length === 0) {
    toast('当前没有可清理的进程', true);
    return;
  }
  const scope = processFilter ? '当前搜索结果中的' : '所有的';
  openConfirm('全部清理', `确定要清理${scope} ${processes.length} 个进程吗？这一操作会影响所有 Server Manager 上匹配的进程。`, () => batchTerminate(processes.map((item) => item.id)));
});

/* ---------- confirm dialog ---------- */

function openConfirm(title, text, onOk) {
  const dialog = el('confirm-dialog');
  el('confirm-title').textContent = title;
  el('confirm-text').textContent = text;
  const ok = el('confirm-ok');
  const cancel = el('confirm-cancel');
  const close = () => { dialog.close(); ok.removeEventListener('click', onOk); cancel.removeEventListener('click', close); };
  ok.addEventListener('click', onOk);
  cancel.addEventListener('click', close);
  dialog.showModal();
}

/* ---------- per-process log path (Oracle queried on demand) ---------- */

function showLogPath(process, button) {
  const dialog = el('logpath-dialog');
  el('logpath-name').textContent = '查询中…';
  el('logpath-full').textContent = '';
  el('logpath-error').classList.add('hidden');
  dialog.showModal();
  api('/api/process/log-path', { method: 'POST', body: { targetKey: process.targetKey, id: process.id } })
    .then((data) => {
      el('logpath-name').textContent = data.logFile || '（数据库中没有该 PID 的记录，可能进程刚启动或已重启）';
      el('logpath-full').textContent = data.logPath || data.rawTail || '';
      dialog._fullPath = data.logPath || '';
    })
    .catch((error) => {
      if (error.status === 401) { dialog.close(); show('login'); return; }
      el('logpath-name').textContent = '';
      el('logpath-error').textContent = error.message;
      el('logpath-error').classList.remove('hidden');
      dialog._fullPath = '';
    })
    .finally(() => { button.disabled = false; });
}

el('logpath-copy').addEventListener('click', async () => {
  const text = el('logpath-dialog')._fullPath;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('路径已复制');
  } catch {
    // Clipboard API needs a secure context; fall back to a manual selection.
    const range = document.createRange();
    range.selectNodeContents(el('logpath-full'));
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    toast('已选中路径，请 Ctrl+C 复制');
  }
});
el('logpath-close').addEventListener('click', () => el('logpath-dialog').close());

/* ---------- per-process management dialog (Logging / Log Levels / Monitoring) ---------- */

let manageState = null;

function manageCall(manageOp, arg1 = '', arg2 = '') {
  return api('/api/process/manage', {
    method: 'POST',
    body: { targetKey: manageState.targetKey, serverId: manageState.serverId, manageOp, arg1, arg2 }
  });
}

function attrValue(attributes, name) {
  const found = (attributes ?? []).find((item) => item.name === name);
  return found ? found.value : '';
}

function openManage(process) {
  manageState = { targetKey: process.targetKey, serverId: process.serverId, tab: 'logging', loaded: {} };
  el('manage-title').textContent = process.serverId;
  setManageTab('logging');
  el('manage-dialog').showModal();
}

function setManageTab(tab) {
  manageState.tab = tab;
  document.querySelectorAll('.manage-tab').forEach((node) => node.classList.toggle('active', node.dataset.tab === tab));
  const body = el('manage-body');
  body.innerHTML = '<div class="loading">加载中…</div>';
  if (tab === 'logging') renderLoggingTab(body);
  else if (tab === 'levels') renderLevelsTab(body);
  else renderMonitoringTab(body);
}

document.querySelectorAll('.manage-tab').forEach((node) => {
  node.addEventListener('click', () => setManageTab(node.dataset.tab));
});
el('manage-close').addEventListener('click', () => el('manage-dialog').close());

/* ---------- Logging tab ---------- */

async function renderLoggingTab(body) {
  let data;
  try {
    data = await manageCall('server-log-status');
  } catch (error) {
    body.innerHTML = `<div class="loading">${error.message}</div>`;
    if (error.status === 401) { el('manage-dialog').close(); show('login'); }
    return;
  }
  const sqlNames = ['SQL  Logging Enabled', 'SQL Profile', 'SQL Show Bind Variables', 'SQL Timing', 'SQL To the Journal file'];
  const sqlLabels = ['SQL Logging', 'Profile', 'Show Bind Variables', 'Timing', 'To Journal File'];
  const toBool = (value) => String(value).trim().toLowerCase() === 'true';
  const checkingLevel = attrValue(data.attributes, 'Checking Level');
  const journalFull = toBool(attrValue(data.attributes, 'Journal Log'));
  const journalPerf = Number(attrValue(data.attributes, 'Journal Performance-only') || 0);
  const journalStats = toBool(attrValue(data.attributes, 'Journal Statistics'));
  manageState.sqlNames = sqlNames;
  manageState.journalPerfLevel = journalPerf;

  body.innerHTML = '';
  const section1 = document.createElement('div');
  section1.className = 'manage-section';
  section1.innerHTML = `
    <h4>Syslog Options</h4>
    <div class="kv"><div><dt>Checking Level</dt><dd>${checkingLevel}</dd></div></div>
    <div class="check-row" id="sql-row"></div>
    <div class="check-row"><button id="sql-apply" class="btn small">应用 SQL 日志设置</button></div>
    <h4>Syslog Operations</h4>
    <div class="check-row">
      <button id="show-syslog" class="btn small">Show Syslog</button>
      <label class="inline">Max Size (KB): <input id="syslog-kb" type="number" value="2000" min="1" max="16000" class="num"></label>
    </div>
    <pre id="log-content" class="log-content hidden"></pre>
    <h4>Journaling Options</h4>
    <div class="check-row" id="journal-row"></div>
    <h4>Journaling Operations</h4>
    <div class="check-row">
      <button id="show-journal" class="btn small">Show Journal</button>
      <label class="inline">Max Size (KB): <input id="journal-kb" type="number" value="2000" min="1" max="16000" class="num"></label>
    </div>
    <div class="check-row">
      <button id="clear-stats" class="btn small">Clear Statistics</button>
      <button id="dump-stats" class="btn small">Dump Statistics to Syslog</button>
    </div>`;
  body.append(section1);

  // SQL logging checkboxes
  const sqlRow = section1.querySelector('#sql-row');
  sqlNames.forEach((name, index) => {
    const label = document.createElement('label');
    label.className = 'inline';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = toBool(attrValue(data.attributes, name));
    check.dataset.sqlIndex = String(index);
    label.append(check, document.createTextNode(sqlLabels[index]));
    sqlRow.append(label);
  });
  section1.querySelector('#sql-apply').addEventListener('click', async (event) => {
    const flags = [...sqlRow.querySelectorAll('input[type=checkbox]')].map((check) => (check.checked ? 'true' : 'false')).join(',');
    event.target.disabled = true;
    try {
      await manageCall('set-sql-logging', flags);
      toast('SQL 日志设置已下发');
    } catch (error) { toast(error.message, true); } finally { event.target.disabled = false; }
  });

  // Journaling option checkboxes
  const journalRow = section1.querySelector('#journal-row');
  const journalOptions = [
    { label: 'Write Full Journal Entries', checked: journalFull },
    { label: 'Write Performance-only Journal Entries', checked: journalPerf > 0 },
    { label: 'Collect Journal Statistics', checked: journalStats }
  ];
  journalOptions.forEach((option) => {
    const label = document.createElement('label');
    label.className = 'inline';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = option.checked;
    check.addEventListener('change', async () => {
      check.disabled = true;
      try {
        if (option.label.startsWith('Write Full')) {
          await manageCall('journal-action', check.checked ? 'start-full' : 'stop');
        } else if (option.label.startsWith('Write Performance')) {
          await manageCall('journal-action', check.checked ? 'start-perf' : 'stop', String(journalPerf || 0));
        } else {
          await manageCall('stats-action', check.checked ? 'start' : 'stop');
        }
        toast('操作已下发');
      } catch (error) {
        check.checked = !check.checked;
        toast(error.message, true);
      } finally { check.disabled = false; }
    });
    label.append(check, document.createTextNode(option.label));
    journalRow.append(label);
  });
  const modulesButton = document.createElement('button');
  modulesButton.className = 'btn small';
  modulesButton.textContent = 'Config for modules';
  modulesButton.addEventListener('click', openModulesDialog);
  journalRow.append(modulesButton);

  // Show syslog / journal
  const showContent = (op, kbInput, pre) => async (event) => {
    event.target.disabled = true;
    pre.textContent = '读取中…';
    pre.classList.remove('hidden');
    try {
      const result = await manageCall(op, kbInput.value || '2000');
      pre.textContent = result.content || '（空）';
    } catch (error) {
      pre.textContent = `读取失败：${error.message}`;
    } finally { event.target.disabled = false; }
  };
  section1.querySelector('#show-syslog').addEventListener('click', showContent('show-syslog', section1.querySelector('#syslog-kb'), section1.querySelector('#log-content')));
  section1.querySelector('#show-journal').addEventListener('click', showContent('show-journal', section1.querySelector('#journal-kb'), section1.querySelector('#log-content')));
  section1.querySelector('#clear-stats').addEventListener('click', async (event) => {
    event.target.disabled = true;
    try { await manageCall('stats-action', 'clear'); toast('统计已清除'); } catch (error) { toast(error.message, true); } finally { event.target.disabled = false; }
  });
  section1.querySelector('#dump-stats').addEventListener('click', async (event) => {
    event.target.disabled = true;
    try { await manageCall('stats-action', 'dump'); toast('已导出统计到 syslog'); } catch (error) { toast(error.message, true); } finally { event.target.disabled = false; }
  });
}

async function openModulesDialog() {
  const dialog = el('modules-dialog');
  const list = el('modules-list');
  list.innerHTML = '<div class="loading">加载中…</div>';
  dialog.showModal();
  try {
    const data = await manageCall('journal-modules');
    list.innerHTML = '';
    for (const module of data.modules ?? []) {
      const label = document.createElement('label');
      label.className = 'inline block';
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = module.active;
      check.dataset.module = module.name;
      label.append(check, document.createTextNode(module.name));
      list.append(label);
    }
    if (!list.children.length) list.innerHTML = '<p class="muted">没有可配置的模块。</p>';
  } catch (error) {
    list.innerHTML = `<p class="error">${error.message}</p>`;
  }
  el('modules-save').onclick = async () => {
    const checks = [...list.querySelectorAll('input[type=checkbox]')];
    const assignments = checks.map((check) => `${check.dataset.module}=${check.checked ? 'true' : 'false'}`).join('\u001f');
    el('modules-save').disabled = true;
    try {
      await manageCall('set-journal-modules', assignments);
      toast('模块 Journal 设置已下发');
      dialog.close();
    } catch (error) {
      toast(error.message, true);
    } finally { el('modules-save').disabled = false; }
  };
}

/* ---------- Log Levels tab ---------- */

const COMMON_LEVELS = ['DEFAULT', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'TRACE', 'FATAL', 'OFF'];

async function renderLevelsTab(body) {
  let data;
  try {
    data = await manageCall('log-levels');
  } catch (error) {
    body.innerHTML = `<div class="loading">${error.message}</div>`;
    if (error.status === 401) { el('manage-dialog').close(); show('login'); }
    return;
  }
  const loggers = data.loggers ?? [];
  manageState.loggers = loggers;
  body.innerHTML = `
    <div class="check-row"><input id="level-filter" class="search" type="search" placeholder="过滤 logger 名称…"></div>
    <div id="levels-list" class="levels-list"></div>`;
  const list = body.querySelector('#levels-list');
  const priorities = [...new Set([...COMMON_LEVELS, ...loggers.map((item) => item.priority)])];

  const render = () => {
    const filter = body.querySelector('#level-filter').value.trim().toLowerCase();
    list.innerHTML = '';
    for (const logger of loggers) {
      if (filter && !logger.name.toLowerCase().includes(filter)) continue;
      const row = document.createElement('div');
      row.className = 'level-row';
      const depth = logger.name.split('.').length - 1;
      row.style.paddingLeft = `${8 + depth * 18}px`;
      const select = document.createElement('select');
      select.className = 'num';
      for (const level of priorities) {
        const option = document.createElement('option');
        option.value = level;
        option.textContent = level;
        if (logger.priority === level || (level === 'DEFAULT' && logger.priority === '')) option.selected = true;
        select.append(option);
      }
      select.addEventListener('change', async () => {
        select.disabled = true;
        try {
          await manageCall('set-log-level', logger.name, select.value === 'DEFAULT' ? '' : select.value);
          logger.priority = select.value;
          toast(`${logger.name} → ${select.value}`);
        } catch (error) {
          toast(error.message, true);
          select.value = logger.priority || 'DEFAULT';
        } finally { select.disabled = false; }
      });
      const name = document.createElement('span');
      name.textContent = logger.name;
      name.className = 'mono';
      row.append(select, name);
      list.append(row);
    }
    if (!list.children.length) list.innerHTML = '<p class="muted">没有匹配的 logger。</p>';
  };
  body.querySelector('#level-filter').addEventListener('input', render);
  render();
}

/* ---------- Monitoring tab ---------- */

async function renderMonitoringTab(body) {
  let data;
  try {
    data = await manageCall('monitoring-status');
  } catch (error) {
    body.innerHTML = `<div class="loading">${error.message}</div>`;
    if (error.status === 401) { el('manage-dialog').close(); show('login'); }
    return;
  }
  manageState.monitoring = data;
  body.innerHTML = `
    <h4>Master Monitoring Mode</h4>
    <div class="check-row" id="monitor-modes"></div>
    <h4>Metrics</h4>
    <table class="process-table" id="metrics-table"></table>
    <div class="check-row">
      <button id="clear-all-history" class="btn small">Remove History（全部）</button>
      <button id="monitor-refresh" class="btn small">Refresh</button>
    </div>
    <pre id="events-view" class="log-content hidden"></pre>
    <h4>Responders</h4>
    <div id="responders-list"></div>`;
  const modesRow = body.querySelector('#monitor-modes');
  const currentMode = data.monitoringMode || 'Off';
  for (const mode of ['Off', 'DisableAlerts', 'Normal']) {
    const label = document.createElement('label');
    label.className = 'inline';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'monitor-mode';
    radio.value = mode;
    radio.checked = currentMode === mode;
    radio.addEventListener('change', async () => {
      if (!radio.checked) return;
      radio.disabled = true;
      try {
        await manageCall('set-monitoring-mode', mode);
        toast(`主监控模式 → ${mode}`);
      } catch (error) {
        radio.checked = false;
        toast(error.message, true);
      } finally { radio.disabled = false; }
    });
    label.append(radio, document.createTextNode(mode));
    modesRow.append(label);
  }

  const table = body.querySelector('#metrics-table');
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>Metric</th><th>Mode</th><th>Started</th><th>Recent</th><th>Historical</th><th>操作</th></tr>';
  table.append(thead);
  const tbody = document.createElement('tbody');
  for (const metric of data.metrics ?? []) {
    const row = document.createElement('tr');
    for (const key of ['metricId', 'mode', 'dateStarted', 'recent', 'historical']) {
      const cell = document.createElement('td');
      cell.textContent = metric[key] ?? '';
      row.append(cell);
    }
    const actions = document.createElement('td');
    actions.className = 'nowrap';
    for (const [label, kind] of [['Recent', 'recent'], ['Historical', 'historical']]) {
      const button = document.createElement('button');
      button.className = 'btn small';
      button.textContent = label;
      button.addEventListener('click', async () => {
        const pre = body.querySelector('#events-view');
        pre.classList.remove('hidden');
        pre.textContent = '读取中…';
        try {
          const result = await manageCall('metric-events', metric.metricId, kind);
          pre.textContent = (result.events ?? []).join('\n') || '（无事件）';
        } catch (error) { pre.textContent = `读取失败：${error.message}`; }
      });
      actions.append(button);
    }
    const clear = document.createElement('button');
    clear.className = 'btn danger small';
    clear.textContent = '清除历史';
    clear.addEventListener('click', () => {
      openConfirm('清除事件历史', `确定要清除 ${metric.metricId} 的事件历史吗？`, async () => {
        try {
          await manageCall('clear-metric-history', metric.metricId);
          toast('事件历史已清除');
          setManageTab('monitoring');
        } catch (error) { toast(error.message, true); }
      });
    });
    actions.append(clear);
    row.append(actions);
    tbody.append(row);
  }
  table.append(tbody);
  if (!(data.metrics ?? []).length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = '没有配置监控指标。';
    body.insertBefore(empty, table);
  }
  body.querySelector('#clear-all-history').addEventListener('click', () => {
    openConfirm('清除全部事件历史', '确定要清除所有指标的事件历史吗？', async () => {
      try {
        await manageCall('clear-metric-history', '__ALL__');
        toast('事件历史已清除');
        setManageTab('monitoring');
      } catch (error) { toast(error.message, true); }
    });
  });
  body.querySelector('#monitor-refresh').addEventListener('click', () => setManageTab('monitoring'));
  const responders = body.querySelector('#responders-list');
  for (const responder of data.responders ?? []) {
    const item = document.createElement('div');
    item.textContent = responder;
    responders.append(item);
  }
  if (!responders.children.length) responders.innerHTML = '<p class="muted">没有 Responder。</p>';
}

/* ---------- boot ---------- */

(async function boot() {
  try {
    const session = await api('/api/session');
    state.userId = session.userId;
    state.csrf = session.csrf;
    state.demo = Boolean(session.demo);
    el('current-user').textContent = session.userId;
    el('demo-badge').classList.toggle('hidden', !state.demo);
    show('main');
    await loadStatus();
  } catch {
    show('login');
  }
})();

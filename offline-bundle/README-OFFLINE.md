# 内网离线安装包说明（版本 0.2.0）

本目录用于在不能访问互联网的内网 Windows Server 上安装/升级 TC 管理控制台（精简版），支持**全新安装**和**旧版本一键升级**。

> 仓库只提交安装脚本；**Node.js 运行时 ZIP 与 `node_modules` 不入库**（体积过大），需在有网机器上按下方"组装离线包"一次性准备好，再把整个目录拷入内网。

## 组装离线包（在有网机器上做一次）

1. 复制应用文件：把仓库根目录的 `src`、`public`、`adapters`、`test`、`package.json`、`package-lock.json`、`config.example.json` 等复制到本目录的 `app\` 下（与仓库内目录结构一致）。
2. 准备依赖：在 `app\` 目录执行 `npm install`（`oracledb` 为 thin 纯 JS 模式，**无需 Oracle 客户端**），把生成的 `app\node_modules` 一并带入内网；内网机器全程不需要联网、不需要再跑 `npm install`。
3. 准备 Node 运行时：从 Node.js 官网下载 `node-v24.21.0-win-x64.zip` 放到 `packages\`，并把官方 `SHASUMS256.txt` 放在同目录；运行 `verify-packages.ps1` 校验通过。
4. 把仓库里的 `config.example.json` 复制为 `app\config.json` 并按现场预填（Server Manager 的 `jmxUrl` / `managerId`、Oracle 连接串、日志路径前缀）。Oracle 密码不要写进去，安装后用环境变量注入。

最终结构：

```
offline-bundle/
├─ install.cmd / install-offline.ps1    一键安装/升级
├─ verify-packages.ps1                  Node 运行包校验
├─ start-demo.cmd / start-production.cmd / stop.cmd / stop-mgmt-console-lite.ps1
├─ packages/node-v24.21.0-win-x64.zip + SHASUMS256.txt
└─ app/                                 应用完整文件（含 node_modules、config.json）
```

## 包含内容

- `install.cmd`：**一键安装/升级入口**（双击即可，默认安装到 `D:\Apps\mgmt-console-lite`，可用 `-InstallRoot` 改）。
- `install-offline.ps1`：安装脚本本体（校验 → 解压 → 复制 → 配置迁移 → Java 检查 → 自检测试 → oracledb 检查）。
- `start-demo.cmd` / `start-production.cmd` / `stop.cmd` / `stop-mgmt-console-lite.ps1`：启停脚本。
- `app`：应用完整文件。
- `app\adapters`：JMX 桥（`tc-mgr-adapter` + `tc-mgr-jmx.jar`，源码在 `adapters\java\`，改 Java 后用 `adapters\build.cmd` 重建）。

## 环境要求

- Windows x64（Server 2016+ / Win10+）。
- **JDK 或 JRE 11+**（JMX 桥每次调用会启动一个 JVM）。装在默认 PATH 即可；否则设置系统环境变量 `TC_JAVA_HOME` 指向 JDK 根目录。安装器会自动检测并提醒。
- 网络连通：到 Server Manager 的 **JMX 端口（默认 8088）**和 Oracle 的 **1521**。建议 `jmxUrl` 一律使用**主机名**（个别环境按 IP 走会在 TCP 建连后被安全设备中断）。

## 一、全新安装（三步）

1. 把整个目录复制到服务器任意位置，**双击 `install.cmd`**。
   - 命令行等价方式：`powershell -NoProfile -ExecutionPolicy Bypass -File install-offline.ps1 -InstallRoot 'D:\Apps\mgmt-console-lite'`
   - 脚本自动完成：Node 运行包校验与解压 → 复制应用 → 保留/生成 `app\config.json` → Java 可用性检查 → 全部自检测试 → oracledb 模块检查。
2. 设置 Oracle 密码（用于"日志"按钮按需查询 `PM_PROCESS_LIST`）：
   - 临时：直接运行 `start-production.cmd`，脚本会提示输入（只注入本次进程，不落盘）；
   - 永久：管理员窗口执行 `setx TC_DB_PASSWORD "infodba 的密码"`，然后**重开窗口**再启动。
   - 密码不进任何配置文件、不进命令行参数、不进日志。
3. `start-production.cmd` 启动 → 浏览器打开 `http://127.0.0.1:8095`，用 **Server Manager 的登录账号密码**登录（登录即 JMX 验证）。停止用 `stop.cmd`。

> 建议正式对外时启用 HTTPS（`config.json` 的 `tls` 节 + `publicBaseUrl` 改为 https），登录口承载的是 Server Manager 密码。

## 二、旧版本升级

1. 停止服务：运行安装目录下的 `stop.cmd`（不要直接 taskkill node.exe）。
2. 备份 `D:\Apps\mgmt-console-lite\app\config.json` 和 `app\logs\` 审计日志。
3. 把新离线包复制到服务器，**双击新包里的 `install.cmd`**（安装目录与旧版相同）。
   - 脚本会**保留现有 `config.json`**，并自动补齐缺失字段（会打印补了什么）：`mode`、`adapter.statusCacheMs`、`processLog` 等。
   - 应用文件全部更新（含搜索/批量清理/日志名按需查询/Logging / Log Levels / Monitoring 三个管理页签）。
4. `start-production.cmd` 启动，浏览器 **Ctrl+F5** 强刷。

## 三、安装后验证清单

- [ ] 安装器末尾自检测试全绿（无 JDK 时 JMX 桩相关用例自动跳过）。
- [ ] `http://127.0.0.1:8095/health` 返回 `{"status":"ok","mode":"command"}`。
- [ ] 用 Server Manager 账号登录成功；「服务器状态」页显示各 Pool 计数（Total/Warm/... 与原管理控制台一致）。
- [ ] 「进程清理」页列出全部进程（Server/PID/Lifecycle/User/Mode/Status/Duration）。
- [ ] 点某行的「日志」：弹窗出现 `tcserver.exeXXXXXXXX.syslog` 文件名和完整路径，「复制路径」可用。
- [ ] 点某行的「管理」：三个页签能打开——Logging 显示 Checking Level 与 SQL 开关；Log Levels 显示 logger 列表；Monitoring 显示 Master Monitoring Mode 与指标表。
- [ ] 搜索框按 PID 过滤；勾选两个进程 → 「批量清理选中 (N)」；「全部清理」需二次确认。
- [ ] 服务控制台出现中文审计行，`app\logs\` 里有按天 JSONL 和中文摘要。

## 四、配置字段速查（app\config.json）

| 字段 | 说明 |
|---|---|
| `mode` | `demo` 为演示模式（demo/demo，模拟数据）；生产必须 `command`，`NODE_ENV=production` 时拒绝 demo |
| `listenHost` / `listenPort` | 监听地址（默认 127.0.0.1:8095）；对外发布改 `0.0.0.0` 并配反向代理或 TLS |
| `targets[]` | 每个 Server Manager 一条；`jmxUrl` 建议用主机名，形如 `service:jmx:rmi:///jndi/rmi://主机:8088/jmxrmi` |
| `processLog.oracle.connectString` | `主机:1521/服务名`；`user` 默认 infodba；密码走 `passwordEnv` 指定的环境变量 |
| `processLog.pathPrefixes` | 按 Pool 配置 syslog 目录前缀，补齐数据库里被截断的路径前缀（数据库只存尾部约 96 字符），到 `...\TcServer\process` 一级 |
| `adapter.timeoutMs` | 每次适配器调用（JVM 启动 + JMX）超时，默认 30000 |
| `sessionMinutes` | 会话时长（滑动过期），默认 15 |

## 五、常见问题

- **登录报"账号或密码错误，或 Server Manager 暂不可达"**：确认账号是 Server Manager 的登录账号；注意 Oracle 的 infodba 密码 ≠ JMX 密码。详情看服务窗口的 `login failed for ...` 行。
- **登录成功但进程列表为空 / 状态页报错**：多为网络链路问题，优先改用主机名并确认 DNS 解析与 8088 端口连通（`ping 主机名`、`telnet 主机名 8088`）。
- **「日志」按钮报错**：检查 `TC_DB_PASSWORD` 是否已设置、1521 是否可达；报错只显示在弹窗中，不影响进程列表。
- **Java 相关**：`TC_JAVA_HOME` 指向 JDK 根目录（含 `bin\java.exe`）；改过 `adapters\java\*.java` 后执行 `adapters\build.cmd` 重建 `tc-mgr-jmx.jar`。

# TC 管理控制台（精简版）· mgmt-console-lite

> 一个独立部署的轻量级 Web 控制台，用于替代 Siemens **Teamcenter Management Console** 的日常管理功能：查看各 Server Manager / Pool 的进程状态、重启 Warm 服务器、清理 tcserver 进程，并按进程管理日志。无需 WebLogic、无需部署 EAR，一个 Node.js 进程 + 一个 JMX 桥即可运行。

- **运行时**：Node.js ≥ 20（ESM，零前端框架，唯一 npm 依赖 `oracledb`，thin 纯 JS 模式）
- **JMX 桥**：单文件 Java（[MgrJmxBridge.java](adapters/java/MgrJmxBridge.java)），仅依赖 JDK 自带 JMX API，Java 11 编译
- **平台**：Windows x64（Server 2016+ / Win 10+），提供内网**离线安装包**组装脚本
- **认证**：直接以 Server Manager 账号登录（登录即一次真实 JMX 校验），无独立用户库

## 为什么需要它

原版 Teamcenter Management Console 功能庞杂（Config、Log Levels、Manager Monitoring、Tc Server 等多个菜单），而一线管理员日常高频操作只有三类：

1. 看每个 Server Manager / Pool 里有多少 tcserver 进程、各是什么状态（最不重要的功能）；
2. 一键 **Restart Warm Servers**（精简后，只保留了重启warm进程的菜单，降低操作者的操作风险）；
3. 找到指定的 tcserver 进程并**清理（Shutdown）**。
4. 在TC运维的工程中经常遇到需要查看syslog日志名字时，不知道文件名是什么，管理控制台虽然可以直接查看日志，但是当日志超过一定数量后，就无法直接查看，这个控制台可以通过并行查询TC数据库的方式查询到进程的真实日志文件名，方便查看

本项目把这三件事做到一个单页 Web 界面里，去掉了所有不需要的菜单；并额外补齐了原控制台不好用的地方：跨多个 Server Manager 的**统一进程列表、实时搜索、批量清理、完整中文审计**。

## 功能一览

登录后有两个页签。

### 服务器状态

按 `config.json` 中配置的每个 Server Manager 各显示一张卡片，字段与原控制台 Status 页一致：

- **Counts of various server types**：Total / Assigned / Warm / Warming Up / Edit Mode / Read Mode / Stateless Mode / Terminated Before Normal Timeout / Cold
- **Other miscellaneous properties**：Host Machine / Active Status / Last Restart Warm Servers Time / Assignment Service / Mux
- **Refresh**：实时重读 JMX（服务端带 3s 缓存与单飞合并，防止刷新风暴）
- **Restart Warm Servers**：带二次确认，等价于原控制台 Operation 页同名按钮（对 manager MBean 调用 `Restart_Warm_Servers`）

### 进程清理

对每个 Server Manager 列出**所有 Pool 的全部进程**（等价于原控制台 Tc Server 页）：Server / PID / Lifecycle / User / Mode / Status / Duration(sec)，并提供：

- **搜索框**：按 Server / PID / 用户 / Mode / Status / 日志文件名实时筛选（纯前端过滤，不区分大小写）
- **批量清理**：表头复选框全选当前筛选结果；支持「批量清理选中 (N)」与「全部清理」（可跨 Server Manager；批量上限 50 个，单个失败不影响其余）
- **日志按钮（按需查库）**：点击后才查询 Oracle `PM_PROCESS_LIST`，弹窗显示该进程的 syslog 文件名与完整路径，一键复制——**进程列表本身不访问数据库**
- **管理按钮**：完整复刻原控制台选中进程后的三个页签（走与控制台 bundle 相同的 JMX 调用）：
  - **Logging**：Checking Level、SQL Logging 五个开关（Profile / Show Bind Variables / Timing / To Journal File）、Show Syslog / Show Journal（带 Max Size 上限，内容可复制）、Write Full / Performance-only Journal Entries、Collect Journal Statistics、Config for modules（模块级 Journal 开关）、Clear / Dump Statistics
  - **Log Levels**：该进程的 logger 树，按点分层级缩进，每个 logger 一个级别下拉（支持名称过滤；logger 缺失时自动回退初始化）
  - **Monitoring**：Master Monitoring Mode（Off / DisableAlerts / Normal）、指标表（Metric/Mode/Started/Recent/Historical）、Recent/Historical 事件查看与清除历史、Responders 列表
- **清理**：对选中进程调用 JMX `Shutdown_Server`（二次确认）。清理前服务端会重读一次权威列表，进程已消失时返回"进程已不存在"；每次清理逐条写审计，批量另有汇总记录

### 审计

- 按天输出机器可读的 JSONL（`logs/audit-{date}.jsonl`）与中文摘要日志（`logs/audit-summary-{date}.log`）
- 事件覆盖：登录成功/失败/限流、注销、查看状态、重启 Warm（请求/成功/失败）、查看进程、清理进程（请求/成功/失败，含 PID、serverId、pool、属主、操作人）

## 架构

```
浏览器（public/ 纯静态 HTML/CSS/JS，无框架、无 CDN）
   │ HTTP(S)（HttpOnly Cookie 会话 + X-CSRF-Token 头）
   ▼
Node.js src/server.js（ESM，默认 127.0.0.1:8095；oracledb thin 懒加载）
   ├─ POST /api/login ─────► 用登录凭据做一次真实 JMX status 读取，成功即建会话
   ├─ GET  /api/status ────► src/adapters/manager.js（缓存 + 单飞合并）
   │              └► adapters/tc-mgr-adapter.cmd
   │                     └► Node adapters/tc-mgr-adapter.js
   │                            └► spawn java -cp tc-mgr-jmx.jar MgrJmxBridge
   │                                   └► JMX getAttributes(managerMBean, 14 个属性)
   ├─ POST /api/operation/restart-warm ─► JMX invoke(managerMBean, "Restart_Warm_Servers")
   ├─ GET  /api/processes ─► JMX queryMBeans("Administer <mgrId> servers :id=*")
   │              └► 每个进程读 Process ID/State/Assigned User/Assigned/Ready/Active 等
   │              └► src/adapters/process-logs.js（oracledb thin 连接池，按需）
   │                     └► SELECT pm_key, pm_syslog FROM pm_process_list，按 PID 匹配
   │                        + config.pathPrefixes 拼完整路径
   ├─ POST /api/processes/terminate ─► 重新列表确认存在 → JMX Shutdown_Server(serverId)
   └─ 审计：src/audit.js → logs/audit-{date}.jsonl + logs/audit-summary-{date}.log
```

每次 JMX 调用启动一个短命 JVM 进程，凭据经 stdin（base64）传入，不出现在命令行；JMX 侧通过 `JMXConnector.CREDENTIALS` 传递。

关键协议事实（逆向自 `com.teamcenter.jeti.mgmt.ui.web.servermgr-14.2.0.2.jar` 并经现场验证）：

- Manager MBean 的 ObjectName 域为 `Administer <managerId> manager `（注意 Administer 后与尾部的空格）；不同版本拼写有差异，Java 桥对两种写法都用 `queryNames` 探测并优先精确 id 匹配。
- Status 的 14 个属性值均为 `String[]`（每个 Pool 一项），与原控制台 getServerStatus 一致。
- `Restart_Warm_Servers` 是 manager MBean 上的无参操作。
- 属性精确拼写：`Host`、`Active Status`、`Assignment Service`、`Mux`、`Number of Servers`、`Number of Assigned Servers`、`Number of Warm Servers`、`Number of Warming Up Servers`、`Number of Cold Servers`、`Number of Servers Terminated Before Normal Timeout`、`Servers in Edit Mode`、`Servers in Read Mode`、`Servers in Stateless Mode`、`Last Restart Warm Servers Time`。

### 日志文件名如何得到

tcserver 进程的 syslog 文件名登记在 Oracle 的 `PM_PROCESS_LIST`（Pool Manager 进程登记表）：

- `PM_KEY` = `<8 位十六进制 OS PID>:<8 位十六进制随机数> <主机名>`，其中 **hex1 即 tcserver 进程的 OS PID**（与 JMX `Process ID` 属性、原控制台 PID 列一致）。
- `PM_SYSLOG` 存的是 syslog 完整路径，但**前半段在服务端被截断为 `...`**，只保留尾部约 96 字符。
- 文件名规则：`tcserver.exe + PID 四位 hex + 4 位随机 hex + .syslog`，每次进程启动生成新文件。

因此程序按 **PID → PM_PROCESS_LIST 精确匹配**取文件名，再用 `processLog.pathPrefixes` 中配置的 Pool 路径前缀（配置到 `...\TcServer\process` 一级）拼出完整路径。查询失败只在行内提示，不影响进程列表。

## 环境要求

- **Windows x64**（Server 2016+ / Win 10+）
- **Node.js ≥ 20**（离线包含 Node 24 LTS 运行时组装方案）
- **JDK 或 JRE 11+**：JMX 桥每次调用启动一个 JVM；可用 PATH 中的 `java`，或用 `JAVA_HOME` / `TC_JAVA_HOME` 指定
- 网络可达：目标 Server Manager 的 JMX 端口（默认 **8088**）；启用日志名查询时还需 Oracle **1521**
- Teamcenter 版本：基于 14.2 的管理控制台协议逆向，14.x 应通用；旧版可用内置 probe 诊断

## 快速开始（Demo 模式）

Demo 模式不需要任何真实环境，账号 `demo/demo`，页面数据为内置模拟值，用于体验与二次开发：

```cmd
git clone https://github.com/<your-name>/tc-mgmt-console-lite.git
cd tc-mgmt-console-lite
npm install
run-demo.cmd
```

`run-demo.cmd` 会先跑全部测试再启动，浏览器打开 <http://127.0.0.1:8095>。停止用 `stop.cmd`（按 PID 文件校验，不会误杀其他 node 进程）。

也可以直接：

```cmd
npm test     :: 运行测试
npm start    :: 启动（无 config.json 时默认 demo 模式）
```

## 生产部署（直连真实 Server Manager）

1. **安装依赖与构建 JMX 桥**

   ```cmd
   npm install
   adapters\build.cmd       :: 仅在修改过 adapters\java\*.java 时需要；仓库已内置 tc-mgr-jmx.jar
   ```

2. **创建配置**：复制 [config.example.json](config.example.json) 为 `config.json`，填写每个 Server Manager 的 `key / name / managerId / jmxUrl`：

   ```json
   {
     "mode": "command",
     "listenHost": "127.0.0.1",
     "listenPort": 8095,
     "targets": [{
       "key": "poola",
       "name": "PoolA(servermgr01:8088)",
       "managerId": "PoolA",
       "jmxUrl": "service:jmx:rmi:///jndi/rmi://servermgr01.example.com:8088/jmxrmi"
     }]
   }
   ```

3. **设置 Oracle 密码环境变量**（仅在需要"日志"按钮按需查询 syslog 文件名时；`processLog.mode` 默认为 `off`，可不开）：

   ```cmd
   set TC_DB_PASSWORD=********          :: 本次窗口有效
   :: 或永久生效：setx TC_DB_PASSWORD "********"（之后重开窗口）
   ```

   密码只经环境变量注入，不进配置文件、命令行与日志。

4. **启动**：

   ```cmd
   set NODE_ENV=production
   npm start
   ```

   浏览器打开 `http://127.0.0.1:8095`，用 **Server Manager 的登录账号密码**登录（登录动作本身就是 JMX 校验，无独立用户库）。

> 登录口承载的是 Server Manager 密码，正式对外请启用 `tls`（HTTPS）并把 `publicBaseUrl` 配为 https，或置于反向代理之后并限制来源网段。

### 配置速查

| 字段 | 说明 |
|---|---|
| `mode` | `demo`（模拟数据）或 `command`（真实 JMX）；`NODE_ENV=production` 时拒绝 demo |
| `listenHost` / `listenPort` / `publicBaseUrl` | 监听地址与对外地址（默认 127.0.0.1:8095） |
| `sessionMinutes` | 会话时长 1–120 分钟（默认 15，滑动过期） |
| `adapter.command` / `timeoutMs` / `statusCacheMs` | 适配器命令、超时（1–120s）、状态/进程列表缓存（0–60s；清理与重启后自动失效） |
| `targets[]` | 每个 Server Manager 一项：`key` 唯一（字母数字 `-_`）、`name` 卡片标题、`managerId` 即 JMX 域中的 manager id、`jmxUrl` 为 JMX 服务地址；可选 `pools` 过滤显示的池 |
| `processLog.mode` | `off`（默认）/ `oracle` / `demo`；应用为 demo 模式时 oracle 自动降级为 demo |
| `processLog.oracle` | `user`（默认 infodba）、`passwordEnv`（密码**环境变量名**）、`connectString`（`主机:1521/服务名`） |
| `processLog.pathPrefixes` | 按 Pool（或 managerId）配置 syslog 目录前缀，补齐数据库中被截断的盘符/早期目录，配到 `...\TcServer\process` 一级 |
| `audit` | JSONL 按天 + 中文摘要按天；`reverseDns` 反解计算机名；`trustedProxies` 信任的反代 |
| `tls` | `keyPath` / `certPath` / `caPath`；启用后 `publicBaseUrl` 必须为 https |
| `demoLogin` | demo 模式账号（默认 demo/demo） |

## 内网离线安装

无法访问互联网的 Windows Server 可使用离线包方案，见 [offline-bundle/README-OFFLINE.md](offline-bundle/README-OFFLINE.md)。该目录提供：

- `install.cmd` / `install-offline.ps1`：一键安装/升级（校验 → 解压内置 Node 运行时 → 复制应用 → 配置迁移 → Java 检查 → 自检测试 → oracledb 检查）
- `start-demo.cmd` / `start-production.cmd` / `stop.cmd`：启停脚本
- `verify-packages.ps1`：Node 运行时 SHA256 校验

Node 运行时 ZIP 与 `node_modules` 不入库（体积过大），按离线包说明自行下载组装；`oracledb` 为 thin 纯 JS 模式，**目标机无需安装 Oracle 客户端**。

## 安全设计

- Cookie `HttpOnly` + `SameSite=Strict`（HTTPS 下加 `Secure`）；所有写操作必须携带 `X-CSRF-Token`
- 登录限流：10 次 / 5 分钟 / IP
- CSP `default-src 'self'`、`frame-ancestors 'none'`；无第三方前端依赖、无 CDN
- 密码只存在于服务端内存（随会话注销/进程退出销毁）与 stdin（base64）中，不落盘、不进配置/命令行/日志/审计；Oracle 密码经环境变量注入
- 任何登录成功者拥有全部已配置目标的操作权限——**这是管理员工具**，请用 HTTPS 发布并限制来源网段

## 测试与诊断

```cmd
npm test
```

- 覆盖：config 校验 / 会话 / 日志名解析 / JMX 桩全链路（list / terminate / restart-warm / 登录校验）/ HTTP 集成（demo 模式）
- JMX 全链路测试使用 [StubMgrJmxServer.java](test/fixtures/stub-jmx/StubMgrJmxServer.java) 桩（含 manager MBean、两个 ServerInfo MBean、JMX 认证器），需本机 JDK；无 JDK 时相关用例自动跳过
- 新环境出现"列表为空 / 属性不对"时，先用 probe 在服务器本地诊断（不经 web 暴露）：

  ```json
  {"operation":"probe","username":"...","password":"...","targets":[{"key":"diag","managerId":"PoolA","jmxUrl":"service:jmx:rmi:///jndi/rmi://host:8088/jmxrmi"}]}
  ```

  `adapters\tc-mgr-adapter.cmd < probe.json` 输出全部 JMX domains、Administer MBeans 与 manager MBean 的全部属性。

## 项目结构

```
mgmt-console-lite/
├─ src/                    Node.js 服务端（ESM）
│  ├─ server.js            HTTP(S) 服务、路由、会话/CSRF/限流
│  ├─ config.js            配置加载与严格校验
│  ├─ session-store.js     内存会话（滑动过期）
│  ├─ audit.js             JSONL + 中文摘要审计
│  └─ adapters/
│     ├─ command.js        .cmd 子进程调用（stdin JSON / stdout JSON）
│     ├─ manager.js        状态/进程/重启/清理/进程管理（demo + 真实链路、缓存）
│     └─ process-logs.js   Oracle PM_PROCESS_LIST 按需查询与路径拼接
├─ adapters/               JMX 桥
│  ├─ tc-mgr-adapter.cmd/.js   Node 包装器（凭据 base64 → stdin）
│  ├─ java/MgrJmxBridge.java   唯一 Java 源文件（JDK 自带 API）
│  ├─ build.cmd                javac --release 11 构建脚本
│  └─ tc-mgr-jmx.jar           构建产物（已内置）
├─ public/                 纯静态前端（index.html / app.js / styles.css）
├─ test/                   node --test 测试 + JMX Java 桩
├─ offline-bundle/         内网离线安装脚本（Node 运行时需自行组装）
├─ config.example.json     配置模板
└─ run-demo.cmd / stop.cmd 演示启动 / 停止
```

## 说明

- 本项目为独立第三方管理工具，与 Siemens 无隶属关系，Teamcenter 为 Siemens 的商标。
- 仓库默认不附带 LICENSE 文件（保留所有权利）；如需开源许可条款，请自行添加。

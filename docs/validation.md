# 验收说明 / Validation notes

本页记录本包发布到本公开仓库（`HaneWari/mcode-token-meter`）前的自检结果，供使用者复核。所有数字均来自本机实测。

## 包检查（官方校验器）

用官方社区仓 `MiniMax-AI/MiniMax-Code-MiniApps` 的 `scripts/validate.mjs` 直接检查本包目录：

```text
token-meter-board: 0 errors, 1 warning
  warning ENTRY_STDOUT writes to stdout, which belongs to the Host; log through context.logger instead (miniapp/node/lib/db-child.mjs)
```

**关于 `ENTRY_STDOUT` 这条 warning**：它命中的是 `miniapp/node/lib/db-child.mjs`，而不是 Host 的入口 `miniapp/node/server.mjs`。该文件是我们自己 spawn 出来的子进程执行器（宿主运行时没有 `node:sqlite` 时才走这条路），它把查询结果写进 stdout，**父进程从这条管道读回来**——是父子进程之间的 IPC，不是宿主进程的输出通道；宿主的入口从未写 stdout（校验器对入口的判定是 error 级，此处并未触发）。

校验器的规则是静态扫描：`/\b(?:console\.(?:log|info|debug|dir|table)|process\.stdout\.write)\s*\(/u`，无法区分「宿主入口的 stdout」与「我们自己拉起的子进程的 stdout」。因此这条 warning 属于**可解释的误报**，按官方仓既有的处理方式（参见 `plugins/webguhui/minimax-photo/docs/validation.md`）**保留并在此说明，不修改检查器、也不隐藏代码**。该子进程路径在有 `node:sqlite` 的运行时里不会启用。

## 回归测试

对照 `assistant` 消息的 `usage.{input_tokens,output_tokens,cache_read}` 与用量行 `raw` 同名字段建立**无歧义配对真值**，再逐条核对看板给出的每次调用的 decode / 请求全程时长：

| 窗口 | 核对调用数 | 错配 |
| --- | --- | --- |
| 近 30 天 | 16787 | **0** |
| 近 7 天 | 11043 | **0** |
| 今天 | 1701 | **0** |
| 窗口起点落在某个 turn 中段 | 6515 | **0** |

修复前的同口径测量为：按下标配对错配 **22.5%**（3770/16723），即每 4~5 次调用就有 1 次显示的是**上一通**的 decode 与速率。

状态码匹配同法核对：日志行在用量行之后落盘，按时间就近匹配会落到上一通的日志行（实测 2220 次失手**全部**偏上一通）；改为取「该 turn 中第一条时刻不早于本次调用起点的日志行」后，可判定的 10124 条**命中率 100%**。

其余逐条通过的项目：

- **`dataDir` 注入**：`/api/*` 传入 `?dataDir=<他处路径>` 后返回的仍是宿主数据目录的数据（调用数、输出 token 逐字段一致）；紧接着发出的、不带 `dataDir` 的正常请求也未被污染；`/api/health` 报告的 `dataDir` 仍是宿主目录。全部 7 个端点逐个比对，注入前后响应完全一致。
- **对话明细计数**：`counts`（已完成 / 未收尾 / 进行中）之和等于 `totalTurns`，在 `days=7/limit=50`、`days=30/limit=10`、`days=1/limit=500` 三种组合下均成立（修复前只统计被 `limit` 截断后的部分）。
- **用户消息预览**：全部 ≤ 200 字（库内原文最长 52262 字），截断在 SQL 内完成，原文不进入应用内存。

## 本地归档（v1.10.0）

### 为什么需要它

客户端里删除会话是**硬删除**。宿主自己的实现（`app.asar` → `SessionArtifactService.deleteSession`）一次做掉这些事：

```js
const operations = [
  () => this.owners.queue.deleteSession(sessionId),
  () => this.owners.files.deleteSession(sessionId),
  ...(options.preserveUsage ? [] : [() => this.owners.usage.deleteSession(sessionId)]),
  () => this.owners.messages.deleteSessionData(sessionId),
  () => this.deleteLegacyHistory(sessionId),
  () => this.owners.canonicalHistory.delete(sessionId),   // transcript 目录
  () => this.owners.stream.deleteSession(sessionId),
];
```

`this.owners.usage.deleteSession` 执行的正是 `DELETE FROM local_runtime_token_usage WHERE session_id = ?`；`canonicalHistory.delete` 连 transcript 目录一起删。`preserveUsage` 只给 Peek Session 用，普通删除一律清空。**因此删掉会话后没有任何只读数据源可以恢复它**——这是看板必须自己留一份副本的根本原因。

### 端到端验证

用 `VACUUM INTO` 把运行时库快照成一份副本，在副本上按宿主的方式删掉一个会话，再让看板对着副本跑：

```text
[1] 删除前：30 天窗口内 13,699 次调用 / 2,206,784,718 tokens
    目标会话 mvs_2c8da9a059234f888f784242dd971023（2047 次调用 / 440,714,437 tokens）
[2] 按宿主方式删除：usage=2047  messageRows=2179  session=1
[3] 删除后：13,699 次调用 / 2,206,784,718 tokens（与删除前完全一致）
    归档状态：calls=13699  sessions=154  deletedSessions=1  turns=457
```

逐条断言 9/9 通过：

| 断言 | 结果 |
| --- | --- |
| 被删会话仍出现在会话排行里 | 通过 |
| 它的调用次数不变 | 2047 = 2047 |
| 它的 token 总量不变 | 440,714,437 = 440,714,437 |
| 它的标题被保留 | 「token-meter」 |
| 窗口调用总数不变 | 13,699 = 13,699 |
| 窗口 token 总数不变 | 2,206,784,718 = 2,206,784,718 |
| 逐次调用台账仍列出它的调用 | 通过 |
| 对话明细仍列出它的 23 轮 | 通过 |
| 被删轮次仍显示用户消息原文预览 | 通过 |

### 性能与韧性

同机同法（各端点连续 5 次取中位数、缓存已热），「归档可写」与「归档不可写」两条路径对比：

| 端点 | 归档开 | 归档关 | 差 |
| --- | --- | --- | --- |
| `/api/window?days=1` | 6 ms | 3 ms | +3 ms |
| `/api/window?days=7` | 25 ms | 23 ms | +2 ms |
| `/api/window?days=30` | 47 ms | 59 ms | −12 ms |
| `/api/calls?days=1` | 3 ms | 2 ms | +1 ms |
| `/api/turns?days=1` | 3 ms | 2 ms | +1 ms |
| `/api/sessions?days=30` | 17 ms | 17 ms | 0 ms |
| `/api/daily?days=7` | 11 ms | 13 ms | −2 ms |

归档带来的额外开销在噪声量级（±3 ms）。

- **首次同步**（归档为空时）会做一次全量 pass：13,699 次调用 + 全部 98 个观测日志文件，冷启动首请求 **1,310 ms**；此后每次进程启动的首请求 **107 ms**。
- 归档文件大小：13,699 次调用共 **4.20 MiB**。
- **归档不可写时**（插件数据目录只读）：`/api/window?days=1` 仍返回 **200**，调用数正常，看板照常工作，只是被删除的会话无法补回。

## 性能

同机同法 A/B（同一台机器交替运行 v1.8.0 与 v1.9.0，各端点连续 5 次取中位数、缓存已热）：

| 场景 | v1.8.0 | v1.9.0 |
| --- | --- | --- |
| 冷启动（进程内首次查询） | 1279 ms | 1350 ms |
| `/api/window?days=1` | 9 ms | **8 ms** |
| `/api/window?days=7` | 57 ms | **41 ms** |
| `/api/window?days=30` | 65 ms | **59 ms** |
| `/api/calls?days=1` | 4 ms | **3 ms** |
| `/api/turns?days=1` | 5 ms | **3 ms** |
| `/api/sessions?days=30` | 24 ms | **20 ms** |
| `/api/daily?days=7` | 19 ms | **17 ms** |
| 整页刷新（页面发出的 5 个请求） | 55 ms | **51 ms** |

各项持平或略快，无退化。冷启动 +5% 来自消息事实扫描里多做的两次 JSON 取值（判断该行是否为模型调用、对用户消息做 `substr` 截断）；冷启动本身随机器负载在 0.9~1.4 s 之间浮动。

## 已验证环境

- MiniMax Code 桌面端 **3.1.4**（build 186），Windows 11（10.0.22631，x64）
- 随附 Node.js **v24.18.0**，`node:sqlite` 可用
- 已在桌面端验证：插件安装、窗口切换、自定义起止时间、逐次调用台账、对话明细实时增长、自动刷新、明暗双主题，以及运行时数据库缺失时的报错路径
- macOS 与 Linux **未验证**：代码里没有平台相关逻辑（数据路径由 `context.dataDir` 解析），但请把其他平台视为未测

`docs/preview.png` 使用合成数据实拍，界面为中文。

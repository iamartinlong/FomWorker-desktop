# office-platform · 办公 Agent 平台自研代码

dsh 内核（`../deepseek-harness`）**零改动**。这里的代码经 cordis patch 以 out-of-tree 插件挂载，
不进内核仓库、不进 `packages/`、不改默认 fail-closed。

## 目录

| 路径 | 内容 |
|---|---|
| `plugins/office-approval/ledger.ts` | M1 审批台账：`ctx.storageDomain` 域声明 + 带守卫的状态迁移 + `argsDigest` + `call_index` 快照索引 + `denials` 越权审计表 + 三个共用判定谓词（`isDecidable` 批准之门还开着 / `awaitsDecision` 还欠一次裁决 / `awaitsExpiry` 还欠一次收摊）—— 路由准入、催办判定、重启补武装共用这一个真相源 |
| `plugins/office-approval/ledger.spec.ts` | E3 / E4 / E12 + digest 与 E9 / E10 的验收单测（12 例） |
| `plugins/office-approval/risk-gate.ts` | 挂在 `tools/pre-execute` 的风险闸：L0–L4 分级、ask 前落快照、异常一律拒。导出 `builtinRiskRules`（dsh web profile 全部内置工具名 **+ 我们自己 `--patch` 挂进来的那组**（F-6B 起含五把只读 session-query 工具 L0）的产品字典，每项在注释里给内核 `defineTool` 注册处的 `文件:行`，归类只看实现有没有外部副作用）与 `describeAction`（卡片摘要的唯一来源：未登记工具拿「未识别的工具 X（默认按最高风险处理）」，MCP 动态名单独一句 —— 裸工具名违反 §4，F-H）；「未登记 → L4」这条默认不许放宽 |
| `plugins/office-approval/risk-gate.spec.ts` | F7 接缝 + 不独占 waterfall + 快照/重启 + fail-closed 的验收单测（21 例，真 `ToolRuntime` + 真 `ApprovalService`；其中 7 例钉的是**产品字典本身**——样例字典跑绿不代表产品字典对，F-H 就是这么漏到真进程现场的） |
| `plugins/office-approval/responder.ts` | 同步窗口裁决者：挂在 `approval/request`（`prepend`），grants 命中即放行，否则发卡片等 W_sync，超窗一律 `cancelled`。询问没人答时的收尾**按 `isDecidable` 分岔**：门还开着只把卡片 `defer` 成「转后台、仍可批准」，门关了才 `recall`（F-E）。`findByCall` 命中已有记录时**按状态短路**（F-I）：`approved`/`consumed` → `allowed-once`、`rejected` → `rejected`，其余照常开窗 —— 一次带 `sandbox_permissions` 的调用内核会用同一个 `callId` 问两次，不给短路就是同一轮里开两个窗口 |
| `plugins/office-approval/responder.spec.ts` | E1 / E7 / E13 + grants 与 digest 失配 + E8（策略 `never`）的验收单测（22 例，卡片是终端模拟，其余全真含**真定时器**；第 7 步的 F-D 补了 2 例，F-E 补了「`expiresAt` 早于窗口结束才真撤卡」1 例，F-I 补了「同一个 `callId` 的第二次询问」4 例，含记录仍 `pending` 时**必须仍有两张卡**的反向守卫；U8 补了 1 例——`never` 会话照常落 `pending` 快照、手动 approve 出匹配批件后再发同一动作仍 `isError`/`calls.write=0`/`hasOutstandingGrant` 仍 true，钉住「催办卡残留≠放行口子」这条 fail-closed 不变量，其「批件消费不掉」半侧由内核 never 分支在 `approval/request` 之前判掉、不可变异＝特征化回归） |
| `plugins/office-approval/callback-route.ts` | IM 卡片回调：验签（`sha1(timestamp+nonce+token+body)` + 双向时间窗）→ 租户/审批人名单 → 带守卫的状态迁移 → 落一次性 grant。决策核 `createApprovalCallbackHandler` 与传输无关，`installApprovalCallbackRoute` 才接 `ctx.webServer`；通知走**不 await** 的 `onSettled` 端口（飞书要求 3 秒内 200） |
| `plugins/office-approval/callback-route.spec.ts` | E5 / E6 + §3.6 重复与迟到回调 + `expiresAt` 安全阀 + 与同步窗口共用一本账 + U7 waterfall 顺序的验收单测（24 例，签名用真算法现算，不 mock） |
| `plugins/office-approval/recovery.ts` | 恢复路径（`onSettled` 的落点）：窗口还活着就把结局交给它并**当场收回批件**，否则按内核 `schedule` 的投递三件套 `resolveAgent` → `followup`（`source.kind: 'approval-decision'`）→ `flush` 起新 turn 重放；唤不起才补偿，`flush` 未确认只报告。交给重放的 `tool_call_json` 是**一字不改的参数快照**（含 `justification`，F-J）—— §3.4.1① 说的是它不进 digest，不是可以删掉：少了非空 `justification`，内核 `validateEscalationArgs` 会在派发前把这次调用打回 |
| `plugins/office-approval/recovery.spec.ts` | E2 / E3 / E9 / E10 / E11 + 三条「批准落在窗口或发卡途中」的并发交付验收（11 例）。跑的是**真回合**：真 `AgentLoop` + 真 inbox + 真闸 + 真 `ApprovalService` + 真实 json 台账 + 真定时器 + 真 dispatch，只有模型是脚本 |
| `plugins/office-approval/sweeper.ts` | 催办与过期（§3.5 / D6）：一条 `pending` 审批武装两个时刻（`askedAt+30min` 催办、`expiresAt` 作废），告警层是真 `ctx.schedule`（`at` 必须严格未来、job id 由内核生成、无元数据 ⇒ 对照表记在自己的 `sweeps` 表里，主键分隔符只能是 `_`）。到期动作靠 `armed → fired` 的 CAS 认领；对账只认 `catalog()` 里的投递回执，不认投递正文 |
| `plugins/office-approval/sweeper.spec.ts` | §3.5 的验收单测（25 例，含 E14 的双告警与第 7 步 F-A 的两条「超窗转后台」用例，其中一条真投递进会话）。定时器**不 mock**：真 `ScheduleService` + 真 `at` 触发 + 真 `schedule/changed`，投递由假 agent 记录 |
| `plugins/office-approval/feishu-channel.ts` | 飞书卡片渠道（§4 人因防线 + §5 二次确认）：schema 2.0 卡、按钮 `behaviors[].value` 回传 `{requestId, decision}`、就地 `PATCH /im/v1/messages/{id}`、催办换 `uuid` 重推、过期与撤回（`DELETE` + 另发文本）、`tenant_access_token` 缓存带提前量。卡片有**五种状态**，其中 `deferred`（转后台）与 `awaiting` / `reminded` 一样**按钮仍可点** —— 只有 `decided` / `expired` / `superseded` 才置灰，因为「询问结束」不等于「批准之门关上」（F-E）。§4 的人因数字有两把尺：`sessionRelaxationCount`（累计放宽，只数已批准/已消费）与 U9 的 `sessionRepeatAsks`（同一个 `(toolName, argsDigest)` 被问的第几次，数**所有状态**、剔 `justification`），后者 >1 时在 L3/L4 卡片追加「本会话第 N 次为**同一个动作**请求放宽权限」，把重复交到审批人眼前。网络那一侧收一个 `FeishuTransport`，所以渠道逻辑是隔离可测的 |
| `plugins/office-approval/feishu-channel.spec.ts` | 卡片形状 / 回传值闭合到**真回调路由** / 发卡与就地改卡 / 催办与过期 / 累计放宽次数 / token 缓存的验收单测（46 例，假应答按官方响应形状与业务码造）。第 8 步起有两支真应用撑腰的钉子：**构造白名单**（`div/button/hr/markdown` + `text_tag` 颜色，`action` 容器与 `note` 在 2.0 被真应用拒过 `200861`/`200621`）与 **`uuid` 长度**（按真 36 字符 `randomUUID` 跑，57 字符那版被真应用整条拒过 `99992402`）；F-E 又钉了两条：**`defer` 是 PATCH 而不是 DELETE**、`deferred` 态不置灰；#31 钉了三条：`cardUuid`/`noticeUuid` 把收件人并进摘要 ⇒ 纯函数层「ou-alice≠ou-bob」+ 真传输层「多收件人发卡两条 uuid 各异」「撤回两条通知 uuid 各异」；U9 钉了三条：`sessionRepeatAsks` 纯函数按（同工具 + 同参数指纹、剔 `justification`）数**所有状态**询问（含跨工具/跨文件分开数）+ install 默认策略让超窗重试同一动作的第二张卡自标「本会话第 2 次为**同一个动作**请求放宽权限」（发卡前先落 `pending` 快照，镜像真流程）+ 首次请求不渲染该行 |
| `plugins/office-approval/index.ts` | **产品入口**：六个部件在真 profile 里装配（真 json 台账 + 真 `schedule` + 真 `webServer` 回调 + 真 `sessionController` 唤醒）。`inject` 里每一项都是**必需服务**（cordis 语义：服务不齐就不加载插件，`vendor/cordis/src/registry.ts:105-106`），所以没有 `schedule` 的形态下这一层整体不装 —— 那是「没有 IM 批准入口」，不是「放宽了审批」。配置面有一条 U8 声明字段 `neverSessionsInformativeNotice`（默认「策略为 never 的会话不发放可批准的审批：这里出现的任何卡片只是信息性残留，点批准不会执行任何动作」），`apply()` 用 `logger.info` 回显它，使声明非惰化、在启动日志与 `--dump-config` 里可见——它不改 sweeper/闸的任何行为，只是把「`never` 档位残留催办卡是噪声而非放行口子」写到人能读到的地方 |
| `office-approval.patch.yml` | 真实组合的挂载（`- insert:` 行 + `name` 写相对路径）。用法、`--dump-config` 期望输出、两条 patch 语法坑：见 `../docs/03-验证/M1真实组合spike记录.md` §1 |
| `office-approval.e13.patch.yml` | E13 交棒臂的覆盖行（把 `cardSink` 指到一个目录，让发卡真的抛 `EISDIR`）。⚠️ 非 insert 的覆盖行**整段替换 `config`** 而不是深合并，其余字段会回落到插件默认值 —— 实测见 spike 记录 §1.2 |
| `plugins/office-memory/store.ts` | **记忆层 §7 第 2 步**的落盘核心：`MemoryStore(memoryRoot)`（`resolve` 锚定，非 `path.normalize`）。路径收敛三形逐层拒（绝对路径 / `..` 穿越段 / 逐级 `lstat` 反符号链接，包含判断用大小写敏感前缀，独立于沙箱实现 = MF11）；`writeEntry` 用 `flag:'wx'` 执行「加法优先」（已存在即拒，同时挡住就地重写、水位线丢失后整天重蒸、两进程抢同名文件）；secret 黑名单 `findSecretSignal` 命中即拒写，**拒记只写模式名**（拼正文等于让被拒原文经 `daily/` 落盘，ME7）；`feedback` 类不接受 `source:'external'`（ME6 投毒闸）；`bodySha256` 对规范化正文求（CRLF 不算手改，ME2）。成员会话侧永不写 `MEMORY.md`（ME10 单写者）。第 3 步补 `readIndexForInject()`：**同步**读索引（`lstatSync` 守卫 + `readFileSync`），因为内核的 section `text` provider 签名是同步的、装配不能 await。第 5 步补蒸馏侧五个入口：`readWatermark`/`writeWatermark`（`daily/.watermark` 存 `{lastDistilledAt,lastDay}`，坏/丢按「没有」处理——重蒸幂等，宁可多扫一次不在夜里因坏 JSON 罢工）、`readArmedJob`/`writeArmedJob`（`daily/.distill-armed`，与水位线分文件：标记属成员进程、水位线属蒸馏进程）、`listDailyDays`（`YYYY-MM-DD.md` 升序）、`scanEntries`（只收 `{type}/*.md` 且 `isFile()`，逐条 `readEntry` 失败只跳过——「从现存的好条目重算索引」，不是「一条坏就罢工」）、`writeIndex`（整段覆盖 `MEMORY.md`，**蒸馏进程独有**，成员进程永不走这一步）；`INDEX_HEADER` 常量与 `ReadEntry` 的 `type`/`createdAt` 字段同批加入 |
| `plugins/office-memory/tools.ts` | `createMemoryTools(store)` 出两把模型可见工具：`memory_write`（新条目唯一入口）与 `memory_archive`（成员侧唯一索引变更 —— **先删索引那一行、再 rename**，顺序反了会留下"条目已移动、索引还指着老路径"的孤儿）。两把都走正常 `pre-execute` 风险闸，**不开后门**（§3.6 第 4 条）。第 3 步修 **F-L**：`memory_archive` 返回句改成点名「索引由夜间蒸馏整段重写、缺行不是故障、不要手动补」，因为第 2 步那句「索引里本来没有它的行」被真模型读成索引坏了、要自己去手写 `MEMORY.md`（= ME10 的双写）；`tools.spec.ts` 有一例锁这句话 |
| `plugins/office-memory/inject.ts` | **记忆层 §7 第 3 步**的常驻索引段（纯函数 + provider）：`buildIndexBlock(rawIndex, budget)` 装段并守三条注入守卫 —— 预算（ME1，≤200 行 / ≤4 KB，超限按**类型权重**裁、不看年龄，被裁原行落 `daily` 不静默丢）、注入侧凭据黑名单（ME7，命中行**不进段**、`daily` 只记计数不落原文）、来源隔离/不虚构（ME6/ME11，段只呈现「标题+钩子+链接」，`READ_SIDE_GUIDANCE` 逐句承诺单写者与不虚构，测试断言）；空索引返回空串（内核 `renderPrompt` 丢空段）。`createIndexText(store)` 造内核要的同步 provider，`daily` 留痕异步 `void` 且**按索引内容 sha256 去重**（一夜每份越界索引记一次，不每回合刷） |
| `plugins/office-memory/recall.ts` | **记忆层 §7 第 4 步**的读侧打分腿：`memoryScore = 类型权重 × exp(-Δ天/τ) × 命中密度`（τ 默认 30 天、可注入，DM6）；`TYPE_WEIGHTS`（user 4 / feedback 3 / project 2 / reference 1）；`entryTypeFromLine` 对四种类型做名录校验；`hitDensity` 大小写无关。供第 5 步蒸馏淘汰与检索排序用；注入段的超预算裁序**只借权重这一维、不借时间衰减**（见 `inject.ts`） |
| `plugins/office-memory/distill.ts` | **记忆层 §7 第 5 步**的 Deep Dream 蒸馏确定性核心（覆盖 ME2 / ME3 / ME10 / DM8）：`ageDaysOf`（无/坏 `createdAt` 按 0 天——手写条目必然 `handEdited`，不罚旧）；`planDistill` 纯函数按 DM6 分值降序裁到 `maxLines`——**超线且非手改**者进淘汰候选、**超线但 `handEdited`** 者留下并计 `guardedSkips`（**ME2 压过 ME1 预算**）；`renderIndex` 整段渲染只含幸存行 ⇒ 天然无指向已归档文件的悬空行（ME10）；`distillOnce` 编排「水位线幂等闸 → 可选 `promote` 钩子（模型侧提炼，经 `store.writeEntry` **加法**落盘）→ `archiveEntry` 淘汰 → `writeIndex` 整段重建 → **全部落成才前移水位线** → 记 `office_memory_run` 对账行」——抛错不推水位线（水位线不能跑在内容前面），归档失败不吞（这一夜就是没蒸成功） |
| `plugins/office-memory/run-ledger.ts` | **记忆层 §7 第 5 步**的对账台账：`office_memory_run` storage-domain（`layout:'per-record'`，域名下划线、主键不含冒号——与审批台账同一套约束），`MemoryRunLedger.record` 覆盖写同 runId / `all` 按 `startedAt` 升序 / `latest`。**`runIdOf = run-${startedAt}` 由开始时刻派生而非随机**：`schedule` 投递 at-least-once（MF4），同一次夜间重投收敛到同一行（覆盖写而非多记假账）。对账行回答「这一夜跑没跑、写了/撤了几个文件、被守卫拦下几次」（`outcome` 的 `no-op` 是**成功**不是没跑；`guardedSkips` 是 ME2 观测点）。测试轮询这张表而不是文件系统（领域写链异步） |
| `plugins/office-memory/arm.ts` | **记忆层 §7 第 5 步**的夜间蒸馏武装（幂等）：`DISTILL_TIME='03:30:00.000'` + `DISTILL_TIME_ZONE='Asia/Shanghai'`（`daily` 挂钟 + 显式时区，MF2；错峰整点）；`DISTILL_PROMPT` 自包含纯文本夜间指令（MF6），四条纪律写进正文——单写者不手写 `MEMORY.md` / 只新增不就地重写 / 不写凭据只写环境变量名 / 无新东西就什么都不做不虚构。`DistillAlarmPort` 可测端口，生产实现 `createScheduleDistillAlarms` 用 `ctx.schedule.create` 的一条 `daily` 任务；`ensureDistillArmed` 读 `daily/.distill-armed` 非空即跳过（内核无幂等键 ⇒ 防重启堆叠 recurring），`arm` 抛错则**不写标记**（漏装能重武装）。MF5：只有顶层会话能建定时任务——sessionId 约束由第 6 步装配保证，本模块不假装能替它校验。**⚠️ 部署前提（第 6 步核出，2026-10-11）**：武装监听挂在 `session/created`，而 `installDistillArming` 只装在 `index.ts` 的 `config.distiller` 分支（成员描述符连 `schedule` 都没注入）⇒ **蒸馏进程至少要开一个顶层会话，nightly 才会被装出来**；只启动不建会话的蒸馏进程不会自己开始蒸。设计 §3.5 原文「成员进程的顶层会话做一次」是错的（与 MF3「提醒投进创建它的会话」+ DM7 直接矛盾），已更正 |
| `plugins/office-memory/index.ts` | 记忆层挂载入口：`memoryRoot` 为空**直接抛、不静默不装**（配了一半的台账看起来像"记上了"实则一个字没落盘）；`inject: ['tools','systemPrompt']`，装配 `store` + 注册两把工具 + 挂 `systemPrompt.section`（第 3 步：`name:'office-memory'`、`order:400` 落在 persona=0 与 plan 政策=500 之间、`text` 是 `createIndexText` 那个**同步 provider**、`interpolate:false` 免得记忆正文里的字面 `{{ }}` 被当模板变量抛错）。形状抄 `office-approval/index.ts`（`z<Config>` 标注 + `z.object` 取值）。**第 6 步·代码那半已落地（task #50）**：`apply` 改 async + 按 `config.distiller` 角色门控——成员描述符（`inject:['tools','systemPrompt']`，默认）保持两把写工具 + 注入段、不碰蒸馏线；蒸馏描述符 `OfficeMemoryDistiller`（`inject` 另加必需 `storageDomain`/`schedule`/`sessions`，经 `./plugins/office-memory/distiller.ts` 挂载）才 `new MemoryRunLedger(await ctx.storageDomain.open(memoryRunDomain))` + 注册 `memory_distill` + `session/created` 顶层武装监听；`distiller:true` 配成员描述符在 `apply` 开头响亮抛（防半个蒸馏进程）。剩 §7 第 6 步的**真进程双侧观测 + 真人项**（task #43，需本人在场）|
| `plugins/office-memory/*.spec.ts` | 记忆层验收单测（8 份共 **75 例**：`store` 20 / `tools` 10（含 F-L 一例）/ `risk-gate` 5 / `archive-order` 1 / `inject` 10 / `recall` 8 / `distill` 14 / `arm` 7），覆盖 ME1 / ME5 / ME6 / ME7（写侧+注入侧）/ ME10 / ME11 / ME2 / ME3 / DM8 / 越权三形 / 归档时序 / 打分四条腿 / 蒸馏幂等与武装；`risk-gate.spec.ts` 那 5 例钉的是**产品字典本身**（`memory_write` / `memory_archive` 在 L1 名单里，含 `summarize`）—— F-H 的直接教训：字典必须被断言；`distill.spec.ts` / `arm.spec.ts` 跑**真临时目录 + 真 `storage-json` 台账后端**（不 mock fs/后端——守卫就是文件与落盘行为，mock 掉等于没测） |
| `office-memory.spike.patch.yml` | **记忆层 §7 第 2 步**真进程挂载件：`- insert:` 一行挂 `office-memory`、`config.memoryRoot` 指向 `.spike/memory-spike`（绝对路径，否则启动器 cwd 在内核仓库里会把记忆写进内核工作树）。**无需 agent 名录副本** —— 插件自挂的工具落在全局层、被每个 agent 作用域继承（新事实 MF18，源码证据见 `../docs/02-设计/M1记忆层设计v0.1.md` MF18 行）；本轮故意不叠 session-query |
| `.spike/boot-step2.mjs` | 第 2 步真进程启动器：每次先清空 `.spike/memory-spike` 再起（残留条目会让「同 slug 已存在即跳过」那支探针失真）；`--patch` 三件套（approval + memory + office）+ overlay，detached，轮询 `/office/approval/callback` 得 **405** 判就绪（300 秒不成就 SIGTERM），token URL 只写进 `.spike/step2.url` 不回显 |
| `.spike/newest-ledger.cjs` | 第 2 步观察读取器：转储 `requests/*.json` 里最近 N 条（判「有没有落审批」用**文件计数差**，读最近一条要按 `sessionId` 过滤 —— 残留实例的 sweeper 会碰同一目录）。观察逐臂证据见 `../docs/03-验证/M1记忆层第2步验证记录.md` §4 |
| `office-memory.spike3.patch.yml` | **记忆层 §7 第 3 步**真进程挂载件：与第 2 步那份同形，只差 `memoryRoot` 指向已种好索引的 `.spike/memory-step3`。注入段挂在同一个 `index.ts` 的 apply 里，起进程即装段，无需额外挂段动作 |
| `.spike/seed-memory.mjs` | 第 3 步观察的种子：往空记忆目录种一张 `MEMORY.md`（3 条合法条目行 + 1 行越界凭据）、对应条目文件（frontmatter 带 `bodySha256`）、`.seed-expect.json`（哪几行该进段、哪行该被剔的旁证）。**为何手工种**：`memory_write` 只写条目 + `daily` 线索、不碰 `MEMORY.md`（ME10，整段重建索引是第 5 步蒸馏的活），所以第 3 步能进段的只有磁盘上的 `MEMORY.md` |
| `.spike/boot-step3.mjs` | 第 3 步真进程启动器：**不清空记忆目录**（种子即观察对象），用空端口 3084，其余同 `boot-step2`（三件套 patch + overlay、detached、轮询 callback→405、token URL 只写 `.spike/step3.url`）|
| `.spike/mutate-distill.mjs` | **记忆层 §7 第 5 步**的变异件（m24–m32，共 9 条：水位线闸 / 手改保护 / 预算 / 索引重建四条腿 / 不罚旧 / 武装幂等 / `scanEntries` 过滤）：套件取 `distill / arm / store / archive-order` 四份 spec，基线先绿再逐条应用-跑-还原，日志 `.spike/mutate-distill.log`。结果 **8/9 被抓住**，m32 是**等价变异**（`isFile()` 过滤是纵深防御，符号链接条目在下一层 `readEntry → locate → assertNoInternalLink` 已被第 2 步 m1 钉死，无可观测差异）——逐条红测试见 `../docs/03-验证/M1记忆层第5步验证记录.md` §3 |
| `office-distill.workspace.patch.yml` | **记忆层 §7 第 6 步**蒸馏进程挂载件（task #43 ①）：`- insert:` 挂 `office-memory` 走 `distiller.ts`（`config.distiller: true`、`memoryRoot=.spike/distill-workspace`）+ 覆盖 `sandbox-policy`（**整段重抄** `mode: workspace-write` 与同一路径 `workspaceRoot`，因非 insert 覆盖行不深合并）。**不挂 `office-approval`** ⇒ 蒸馏写自家记忆不 fence、不触发 `approval/request`，ME8 零卡是构造性成立而非放宽。`--dump-config` 静态核挂载已 EXIT=0（`.spike/dump-distill.log`：`office-memory`+`sandbox-policy` 就位、全表无 `office-approval`）；⚠️ 就绪探针在蒸馏进程失效（无 405 路），改以静态核挂载 + `daily/.distill-armed` 标记替代。**真进程双侧观测（③）+ 真人项 V2/V4/V6（④）待本人在场**，#43 未收口 |
| `office-distill.member.patch.yml` | **记忆层 §7 第 6 步**成员进程挂载件（task #43 ①b，双进程的另一半）：`- insert:` 挂 `office-memory` 走 `index.ts`（成员角色，config **只有 `memoryRoot`、无 `distiller`** ⇒ 编译期拿不到 `memory_distill`，ME10 单写者从入口层成立）；`memoryRoot` 指**与蒸馏那份同一个** `.spike/distill-workspace`（双进程共用记忆目录＝协作前提：成员追 `daily/`、蒸馏读同目录重建 `MEMORY.md`）。叠在 `office-approval.patch.yml` 之后跑 `--dump-config` 静态核挂载 **EXIT=0**（`.spike/dump-distill-member.log:1339-1356`：office-approval + office-memory(index.ts) 都在、无 distiller 键）；成员 `workspaceRoot` 保持真实工作区（不设为 memoryRoot）⇒ 工作区外 `write` 照旧发卡（双侧验收的「该问的还问」）。真起进程观测仍待本人在场 |
| `.spike/seed-distill.mjs` | **记忆层 §7 第 6 步**双进程观测的起手态种子（task #43 ②b，纯文件写、不起进程）：往两进程共用的 `.spike/distill-workspace` 摆 5 条条目（`reference/hand-edited-guard.md`＝**ME2 手改靶**，靠「frontmatter 存的哈希 ≠ 正文现算哈希」成立）、水位线之前的 `daily/2026-10-07.md`（DM8 对照：不该再被处理）、水位线之后的 `2026-10-09`/`2026-10-10`（**没有 `newDays` 时 `distillOnce` 直接 no-op，任何守卫都观测不到**）、一张故意坏掉的 `MEMORY.md`（悬空行＝整段重写后必消失的 ME10 硬证据；带假凭据的行＝ME7 注入侧剔除靶；10-10 流水里一行假 `ops_password`＝提炼时必须被黑名单拒记的 V4 投毒靶）与 `.seed-expect.json` 旁证（凭据只记位置不记字面值，否则整目录搜字面值会命中旁证本身而假红）。**刻意不种** `daily/.distill-armed`：武装是待观测事件。默认小种子；`--over-budget` 再放 210 条把索引推过 `maxLines=200`，让「按分值淘汰」与「超线但手改的留下」真的发生。目录非空时默认拒绝重写（种子会整目录删，可能连观测产物一起没），要重来加 `--force` |
| `.spike/check-seed.ts` | 上面那份种子的**真代码自检**（11 项断言，纯读盘）：用 `store.ts`/`distill.ts`/`inject.ts` 把种子读一遍——`readWatermark`、`listDailyDays`（`.watermark` 不算日子）、`newDays` 非空、`scanEntries` 里 `handEdited` **恰好**只有手改靶、正文首字符没被排版吃掉、`indexLine` 与 `indexLineFor` 一字不差、`.distill-armed` 起始态缺席、`buildIndexBlock` 的 `deniedCount===1` 且段里无凭据、`planDistill` 计数、`renderIndex` 形状。跑法（要内核那份 tsx，所以在仓库根执行）：`cd ../deepseek-harness && node --import tsx/esm "../apps/fom-client/.spike/check-seed.ts" <seedDir>`。**为什么值得单列一档**：这一枪当场抓出「闭合 `---` 后少一个换行 ⇒ `parseEntry` 的 `slice(end+5)` 吃掉正文首字符 ⇒ 全目录条目被误判 `handEdited`、蒸馏一条都不敢撤」——肉眼 cat 看不出来。同一处偏移在 `.spike/seed-memory.mjs`（第 3 步那份，当时只走注入段没走 `readEntry`）也已修正。⚠️ `.spike/**` 既不在 `tsconfig.include`（`plugins/**/*.ts`）也不在 `vitest.include`（`plugins/**/*.spec.ts`）⇒ 它**不进**产品的类型闸与测试闸，只由 tsx 当场跑；这是 spike 的边界，不是漏配 —— 判它绿要看上面那条命令的 exit code |
| `.spike/run-step6.mjs` | **记忆层 §7 第 6 步**双进程观测的启动器（task #43 ③的前置）：一条命令把**成员进程**与**蒸馏进程**都起来，并在起之前把两次冷启动（各约 100s）最容易白等的东西检查掉。四份 patch 组合是这一步特有的——成员叠 `office-approval` + `session-query`(durable) + `office-distill.member`，蒸馏**只**叠 `office-distill.workspace`（不挂 approval）；蒸馏进程没有 405 路由可探 ⇒ 就绪判据换成「日志里出现该端口的带 token URL」（token 只落 `.spike/step6-*.url`，不回显）；**把 405 反过来当故障用**——蒸馏端口若回答 405 说明 approval 被挂进来了，ME8「零卡是构造性成立」的前提当场破产，直接杀掉两个进程而不是跑一整夜再发现；起手基线在**两进程就绪之后、任何会话动作之前**落 `.spike/step6-baseline.json`（`requests/` 与 `office_memory_run` 的**文件名清单 + 计数**、日级清单、水位线、`MEMORY.md` 与手改靶正文的 sha256）——观测要的三条判据（ME8 看 `requests/` 的文件名集合没多出蒸馏那一臂的卡 / ME10 悬空行消失 / V2 手改正文一字节没动）全是**差值**，没基线只能靠肉眼回忆；**计数必须下到表这一层**（storage-json 的 per-record 落盘是 `<domain>/<table>/<id>.json`，数域名那层永远得 1＝表名，这是本轮inspect真实磁盘时抓出的启动器缺陷），且记**文件名集合**而非只记数，差值才能指出「哪一张卡」；刻意只记文件名与哈希，不记台账正文（台账在 `.dsh` 下含 `argsSnapshot`，逐条转储不是本步需要）。预检在**一个进程都还没起**时就拦下：缺 `MEMORY.md` 或缺旁证、水位线之后无新日级（no-op 陷阱）、patch 文件不在、端口被占、端口给了 3081（自用验收那台，永不抢/不杀）、`DSH_PERMISSION_MODE` 设成了 `workspace-write` 以外的值（成员那份挂载件把 `sandbox-policy.mode` 写成 `!!js process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`，值从启动器继承的环境来；`danger-full-access` 会让成员工作区外的写**不出卡** ⇒ 观测第 3 枪当场静默观测不到。按白名单拒起而不是 warning；诚实边界：内核若从它自己的 env 文件另设过一次，这一层预检看不见，第 3 枪前在会话权限里确认一次）。跑法：`node .spike/run-step6.mjs --dry-run`（只检查 + 打印两条将执行的命令）／去掉 `--dry-run` 即真起两进程（需本人在场做后续观测）；`--member-port/--distill-port` 换端口。**2026-10-11 已实测的预检闸（逐条验过确实会拦）**：dry-run 全绿 EXIT=0（`newDays=2026-10-09,2026-10-10`、`.distill-armed` 缺席、旁证在场）；`--member-port 3081` → EXIT=1 且不进程；临时占住 3086 → EXIT=1 报「端口已被占用」；临时把两份新日级移走 → EXIT=1 报「水位线之后没有新日级 ⇒ 蒸馏会 no-op 收工」，移回后用 `check-seed.ts` 复跑 **11/11 PASS** 确认种子无损。**「共用记忆目录」那条闸**：预检会用文本读回两份蒸馏挂载件的 `memoryRoot` / `workspaceRoot` 并与启动器算基线用的记忆目录逐字比 —— 这三处此前各写一遍、零断言，改了一边不报错，那一夜两个进程就各读写一个目录（DM7 静默破产）而基线描述的是第三个。三条反向当场改挂载件实测均 EXIT=1（成员 `memoryRoot` 漂走 ⇒「不是同一个目录」；蒸馏 `workspaceRoot` 漂走 ⇒「写记忆目录会 fence、夜里第一件事是提权卡」；键名改坏 ⇒「读不到 memoryRoot，直接拒起」），改完 `diff` 确认逐字节还原。**这一步只验到启动器本身，真进程观测仍未做**。**②e（2026-10-11）观测 arm 两处「文档未规定」已定案并回写设计文档**：①「触发一次 nightly」＝**不改系统挂钟**（改挂钟污染 `.watermark` 与日级文件名的时间线，连带 V4 投毒靶），走设计里既有的确定性手动触发 `memory_distill` 并连叫两次（第二次必须 no-op＝DM8），「到点自跑」以 `daily/.distill-armed` 里的 `{jobId}` 回执 + dsh 侧栏自动化列表登记并如实写明未观测到点火瞬间；②V6 的 durable 索引 path 已就位（成员叠 `session-query.spike.patch.yml`，蒸馏实测 `:memory` + `openAt: never` ⇒ 两进程间 ME4 无碰撞面）。同轮修掉一处**照抄会失败**的缺陷：`--dry-run` 打印的命令原本拼成 `<内核根>\node`（内核根下并没有 `node` 这个文件）且带空格的路径参数没加引号 ⇒ 现在打印 `cwd=` + `"process.execPath"` + 逐参数加引号，与真正 `spawn` 的那一条完全一致；另修 `plugins/office-memory/{store,arm}.ts` 两处旧注释（写的是「成员进程武装 nightly」，实际只有 `index.ts` 的 `config.distiller` 分支装 `installDistillArming`）——纯注释，全套 17 文件 **270 例仍绿**、`tsc` 干净 |
| `.spike/verify-step6.ts` | **记忆层 §7 第 6 步**的**判据计算机**（②q 起它导出的 `readSchedule` 是调度层读法的**唯一生产者**，收口探针也调这一个函数，于是「探针说认得出」与「判据说认得出」不可能各读一份形状；task #43 ②d，纯读盘 + 只读台账文件名，不起进程、不改一个字节）：把 `.spike/run-step6.mjs` 落的起手基线与**当前**磁盘/台账做差（②r 起**差值的两端共用同一份读法**：`sha256File`／`listDailyDays`／`listJsonNames`／`handEditedTarget` 全部 import `.spike/step6-baseline.mjs` 那一个生产者，判据机里原先自写的第二套读法已删——同一段算法写两遍时，一端 `trim()` 后再哈希、一端按字节，两端一起漂而表上看不出任何异常），一次性输出 **14 条判定**并给 exit code（`0`=全 pass、`1`=有 fail、`3`=有 pending 即「还没跑到那一幕」、`2`=参数/基线缺失），把「需本人在场的一夜观测」从肉眼回忆变成一条可重跑的命令。判定 id：`armed-marker`（武装标记在场）／`member-appended-daily`（成员只追加 `daily/`，DM7 共用目录）／`daily-append-only`（②r：日级**只增不减**——基线里有一天现在不见了就判 `fail` 且点名是哪一天，不许像「新增」那样退回 `pending`；DM8 的幂等前提是水已推过的那些日语料还在，被重种冲掉后判据若仍绿＝内容永久失踪没人知道）／`daily-readers-agree`（②r：把生产者那套按名字的日级清单与**产品自己那把尺** `MemoryStore.listDailyDays()`（还要求是普通文件）对账，两边名单不一致就点名「只有基线读法看到／只有产品 store 看到」各自是谁——共用读法消掉了端与端之间的意外互检，这一条是补回来的那一问）／`index-rebuilt`（索引整段重建且**无悬空行**，ME10）／`planted-ghost-gone`（种子里那颗故意悬空行随重建消失）／`watermark-advanced`（水位线前移且没倒退，DM8）／`hand-edited-untouched`（手改靶正文 sha 一字未动＝V2/ME2，手改保护压过预算；②r 起它**先核两端比的是不是同一个文件**——靶路径也改用生产端的解析器，旁证 `.seed-expect.json` 在两时点之间被换过靶时直接判 `fail` 并点名「晚上记的是 X／现在解析的是 Y」，因为这种情况下无论红绿都不说明蒸馏动了什么，却照样能出一个绿）／`must-survive-in-index`／`no-secret-in-memory`（凭据扫描，只报 `文件:行 + 模式名`，绝不回显字面值）／`zero-cards-from-distiller`（ME8，按**文件名集合**差值判，不读台账正文）／`run-rows`（`office_memory_run` 新增行的 outcome 计数）／`dm8-idempotent`（第二次触发无新行）／`nightly-job-single`（②p：**武装标记与内核调度层对账**——读 `tables.tasks` 里标题/正文与 `arm.ts` 导出常量逐字相等的那几行，要求「标记说有一条 ⇒ 调度层也恰好有那一条、且是 `daily`/`03:30:00.000`/`Asia/Shanghai`/`active`」；堆叠、被取消（内核真删行、无墓碑）、残留而标记丢了、文档不在场或读不成都判 `fail` 并各自点名原因，两边都没东西才 `pending`。那份文档**跨实例共享**，所以归属过滤是承重的：本机 39 行全是审批催办那形，不滤就把别人的任务算成堆叠假红）。两条**失败关闭方向**的规矩是本轮自证逼出来的：① 索引重建与「该活下来的行仍在」只在 `MEMORY.md` 的 sha 真的变过之后才判——起手态那颗故意坏行是**种子**，把「蒸馏还没跑」报成 `fail` 会让观测者误读成「跑坏了」，现在报 `pending` 并写明「一字节没动 ⇒ 蒸馏还没跑」；② 台账 per-record 文件是**信封** `{version,record}`，不剥 `record` 就把 outcome 全读成 `?`＝假绿。跑法（同 `check-seed.ts`：要内核那份 tsx，在仓库根执行）：`cd ../deepseek-harness && node --import tsx/esm "../apps/fom-client/.spike/verify-step6.ts" ../apps/fom-client/.spike/distill-workspace --baseline ../apps/fom-client/.spike/step6-baseline.json [--cards-expected 1] [--schedule-file <数据根>/storages/schedule.json] [--out xxx.json]`——**记忆目录是位置参数，没有 `--memory-dir` 这个选项**（本轮实测：给 `--memory-dir` 时 argv[2] 被当成目录名 ⇒ 直接打用法并 exit 2）。`--schedule-file` 缺省指本机数据根那份 `schedule.json`；**数据根不是这里就必须传**，漏传不会报错，只会让第 5 枪把「拿错了文件」说成「任务已被取消」。**它证明的是判据计算，不是第 6 步的观测本身** |
| `.spike/selftest-verify-step6.ts` | 上面那台判据计算机的**自证**（变异式，全在 `fs.mkdtemp` 临时目录里跑真代码，不碰 `.spike/distill-workspace`）：拷种子→用**真生产者** `buildBaseline`（`.spike/step6-baseline.mjs`，②r 起不再手搓基线对象）现算基线→起 `Context` + Storage/StorageJson/StorageDomain 开**真** `MemoryRunLedger`（域只能 open 一次，故在 `freshWorld()` 里开好带上）→用**真** `distillOnce` 蒸馏。正向：① 起手态 14 条判定**无一条 fail** 且 exit=3（`pending` 而非红）；② 蒸馏一次后 9 条 pass；③ 第二次触发 `dm8-idempotent` pass。反向＝把守卫挨个真弄坏再看判定有没有变红：手append 一条悬空行→`index-rebuilt: fail`；写一条干净条目再追加 `ops_password:`→`no-secret-in-memory: fail` **且**补充断言其 detail 里不含该字面值；往手改靶正文追加一行→`hand-edited-untouched: fail`；往 `requests/` 丢一张卡→`zero-cards-from-distiller: fail`（同一张卡配 `--cards-expected 1` 必须变 pass，证明差值不是恒红）。②p 给 `nightly-job-single` 另加一组（3 正向 / 13 反向）：堆叠两行、被取消（真删行无墓碑）、标记丢了、`kind`/`time`/`timeZone`/`status` 四种形状不符、文档不在场、读不成、路径拿错、CLI 那一臂的退出码。②r 给「差值两端共用读法」再加九臂：⑮/⑮b 日级少一天（必须 `fail`、且点名少的是哪一天）、⑯/⑯b 往 `daily/` 放一个**目录**形状的日子（生产者按名字算、产品 store 还要求是普通文件 ⇒ 两边名单不一致，红例点名是哪一边看到的）、⑰a/⑰ 索引含非法 UTF-8 但一字节没被动过 ⇒ 不许报「sha 变了」（⑰a 先证明这份语料确实能分开「按字节」与「按解码串」两种哈希基准，否则 ⑰ 是空跑）、⑱/⑱b 两时点之间手改靶换了文件 ⇒ 判红并把「晚上记的」与「现在解析的」两个路径都点名、⑲ 旁证里靶清单为空 ⇒ 不崩、靶退回经典路径、判定照旧出（`exit=3`）。**红例除了状态对还要说出「该去核哪一层」**——原因混成一句，观测当天就会做错动作（去重装任务 vs 改 `--schedule-file`）。**2026-10-11 实测**：**35 项 `✓` / exit 0**（原有 26 项＝判定层自身 10 + 夜间任务对账 16，②r 那一组再加 9 项）、`PASS …（真 distillOnce + 真 storage-json 台账，临时目录已清理）`；这一枪当场抓出上面 ② 的信封剥壳、`RegExp.exec` 返回 `null` 被当成 `undefined` 判、CLI 守卫被 `selftest-…` 的 `endsWith` 误触发（改精确 basename）、以及 ① 的 fail/pending 方向。本轮还把它自己的坑修掉：补充断言原来只往 `failures` 加数、绿的一面什么都不打印 ⇒ 与「`EXIT=0` 加零输出＝没跑」是同一个签名，读日志的人无法证明那一问真被问过；现在成功行也打 `✓`（总数因此从 20 涨到 26；②r 那九臂再加到 35）。**⚠️ 它只跑在临时拷贝上、一个产品进程都没起**（`distillOnce` 是被直接调用的，不是经 `memory_distill` 工具在真会话里触发的；`daily` 行是照内核 `DailyScheduleRecord` 手搓的临时文档，**内核真写出的那一行从未进过这台自证**）⇒ 真进程那一夜（③）仍是待办 |
| `.spike/mutate-step6-nightly.mjs` | **②p** 那条「夜间任务与武装标记同源」判定的变异件（11 条 a–k，套件取 `selftest-verify-step6.ts` 那份自证、每条改坏 `verify-step6.ts` 一处再重跑）：a 归属过滤去掉 / b 堆叠不判红 / c 取消不判红 / d 标记与调度层各说一件事时放宽成 `pass` / e 逐行列名去掉 / f–i `kind`/`time`/`timeZone`/`status` 四个形状检查各拆一个 / j CLI 那臂的退出码 / k CLI 那臂的点名。**2026-10-11 实测：基线绿，结论「11/11 个变异被断言式抓住」**（日志 `.spike/mutate-step6-nightly.log`，每条红的具名断言见该日志；跑完逐条还原、还原后自证仍 35 ✓）。⚠️ b/c/d 三条是**返工过的写法**：最初按「删掉整个分支」造变异，结果是自证直接崩（`describeRow(undefined)` 抛 TypeError）＝非 0 退出但没有具名红例，按本项目口径**不算抓住**；改成「只放宽状态/只去掉点名」后变异才落在判定层。b/c 现在只被「红例必须说出该去核哪一层」那几条补充断言抓住——这恰好证明上一条留痕纪律不是排版洁癖：不打 `✓` 的断言，谁也说不清它抓住过什么 |
| `.spike/schedule-fixture.ts` | **②q** 内核 `schedule.json` **形状的唯一生产者**：`daily`（夜间蒸馏那一形，默认列值逐字取 `arm.ts` 的常量）与 `at`（审批催办那一形，本机 39 行全是这形）两形、`status` 整列不写那一臂、故意缺列／多列两臂，外加 `DAILY_RECORD_KEYS`（对着内核 `DailyScheduleRecord` 的列集合）。判据自证与收口探针都从这里拿，同一份形状不再有第三处副本 |
| `.spike/probe-schedule-shape.ts` | **②q** §8 第 8 条那条未证前提的**收口探针**：复用 `verify-step6.ts` 导出的那份 `readSchedule`，所以它报的是「**判据认得出**内核真写出的那一行 `daily` 吗」而不是「键名长得像不像」（旧那份只印键名的 `.mjs` 已删——形状全像而文案漂时，两者会各说一句话）。出口码 `0` 认得出且列集合相符／`1` 有 `daily` 形却零归属（该去核 `arm.ts` 文案）或列集合缺／多／`3` 没有 `daily` 形＝还没武装／`2` 读不到或信封换形；只印结构与列名，**标题与正文一律不取**（那份文档跨实例共享）。自证 `.spike/selftest-probe-schedule.ts` **12 项 `✓` / exit 0**、变异 `.spike/mutate-probe-schedule.mjs` **8/8 抓住**；本机对真文档实测 **exit 3**（39 行、`kind` 分布 `at=39`＝`0` 那一支还没被喂过） |
| `.spike/step6-baseline.mjs`（+ 自证 `selftest-step6-baseline.ts`、变异 `mutate-step6-baseline.mjs`） | 起手基线的**唯一生产者**，②r 起也是差值**两端共用的那一份读法**：`sha256File`／`listDailyDays`／`listJsonNames`／`handEditedTarget`／`readWatermark` 五个函数被启动器（产基线）与 `verify-step6.ts`（读当前盘）同时 import，`buildBaseline` 就是自证与判据机共用的基线构造器。**共用读法的代价**：两端之间那份原本意外存在的互检没了 ⇒ 生产端基准漂（典型＝算 sha 前先 `trim()`）时两端**一起漂**，接缝那两条关系断言永远成立。补回来的是自证里那条**绝对锚 ①b**：用不共用那个函数的表达式（`createHash` 直接吃 Buffer）现算同一文件的 sha 并逐字节钉住基准，另断「`trim()` 后必须不同」「文件缺失返回空串而不是抛」——变异件 `d-hash-trims-the-file` 现在**只剩两条不经 `sha256File` 的绝对锚**能抓（①b 那条 + ②s 臂 ⑨ 那条「生产端哈希的正是 `store.writeIndex` 落的那个文件」，实测 2 例红；②r 之前抓它的是两端接缝那两条关系断言，能报多例红——历史计数见验证记录「腿四」，共用读法之后那一族断言随两端一起漂、不再报红）。2026-10-11 实测：自证 **29 项 `✓` / exit 0**、变异 **13/13 抓住**（a 卡文件名清单去掉 / b 台账文件名清单去掉 / c 日级留 `.md` 后缀 / d 见上 / e 手改靶写死 / f 水位线形状不校验 / g 水位线缺失即抛 / h `armedMarkerAtStart` 写死 true / i 台账正文抄进基线 / **j–m 那四个文件名各改一个名**：j `.watermark`→`.distill-watermark`、k `.distill-armed`→`.armed`、l `MEMORY.md`→`MEMORY.markdown`、m `daily/`→`dailies/`）。**②s 那一族为什么不能用「共享代码」收**：那四个名字归产品 `store.ts` 所有（`WATERMARK_PATH`／`ARMED_PATH` 是私有常量，`MEMORY.md` 是内联字面），`.mjs` import 不到 `.ts`，而为仪器给产品加导出＝为工具改产品。于是共享**行为**：自证新增臂 **⑨** 用**真 `MemoryStore`** 往一块空临时盘落（`writeWatermark`／`writeArmedJob`／`writeIndex`／`appendDaily`），再拿生产端那四个读法读回来，断言「两端必须说同一件事」（空目录两端都报「没有」、字段级相等、标记被 `existsSync` 看见、索引 sha 就是那份正文的字节 sha、`appendDaily` 返回的路径在生产端日级清单里同形），`store.ts` 一个字节没动。**补之前的空缺是先量出来、不是推出来的**：见下面那行 `probe-step6-gap.mjs`。铁律由 ⑦＋i 钉住：基线只记**文件名与哈希**，台账正文（`.dsh` 下含别人的 `argsSnapshot`）一个字节都不进那张表 |
| `.spike/probe-step6-gap.mjs` | **②s 的空缺取证件**（一次性，量完即归档）：把 `selftest-step6-baseline.ts` 里的臂 ⑨ 用代码切掉当作「②s 之前的真实形状」（刻意**不是**手写一份旧副本——旧副本会把自己想当然的地方漏掉），对 j／k／l／m 四个改名变异各跑一遍，随后逐字节还原生产端。实测：基线绿；**j、k 完全静默**（红 0 条、exit 0——水位线缺失本来就判 `pending`、武装标记本来就在种子里缺席，改名后没有任何判定变色）；l 红 6 条、m 红 5 条，但都只在起手态那一组**间接**报红，红例点名的是「有一条 fail」而不是「文件名错了」⇒ **检测≠归因**：观测者会被那条红派去核产品行为，根因却在仪器的一个字面（日志 `.spike/probe-step6-gap.log`）。⚠️ 与 `mutate-step6-baseline.mjs` **别同时跑**，两份都改同一个 `.mjs` |
| `.spike/mutate-step6-readers.mjs` | **②r** 那组「差值两端共用同一份读法」的变异件（8 条 a–h，套件取 `selftest-verify-step6.ts`，**变异只打在 `.spike` 仪器上、产品码一字节不动**）：a 「基线有而现在没有」不再计算（恒报只增不减）／b 对账只看产品 store 多出来的、不看只有基线读法看到的／c 当前盘的索引哈希换成 `daily/.watermark`／d 拆掉「晚上记的靶 ≠ 早上解析的靶」那道守卫／e 判据改回自己写死手改靶路径（＝②k 那个原缺陷的镜像面）／f 产品 store 那份清单换成生产者那份（对账自己跟自己算）／g 红例不点名少了哪一天／h 对账红例不报两边各自看到的名单。**2026-10-11 实测：基线绿，8/8 被断言式抓住**（a 2 红／b 2 红／c 3 红／d 1 红／e 2 红／f 2 红／g 1 红／h 1 红，具名红例见 `.spike/mutate-step6-readers.log`），逐条还原、还原后自证仍 35 ✓。⚠️ 造这台时定下的一条口径：判红**前**先自动探测这台自证打的标记字符——`selftest-verify-step6.ts` 打 `×`，`selftest-step6-baseline.ts` 与探针自证打 `✗`，**两台仪器的标记字符不一样**；harness 命中 0 种或 2 种就直接抛。照抄另一台的 `✗` 正则会把整轮变异读成「8/8 全崩」那种假结论，而假结论比没结论更贵 |
| `.spike/mutate-a2.mjs` | **记忆层 §7 第 6 步 A2**的变异件（10 条 a–j，套件取 `office-memory/{risk-gate,arm,index,tools,distill}.spec.ts` + `office-approval/{risk-gate,index}.spec.ts` 共 7 份）：a 删字典行→L4 / b 降 L0 / c 升 L2 / d 中和 `isTopLevelSession` / e 拆角色门 / f 装成功不写幂等标记 / g 去掉 `memoryRoot === ''` 空值守卫 / h 把 `distiller.ts` 的默认导出换成成员描述符 / i 让「配了 App ID 却没 Secret」的守卫永不触发 / j 反转那道守卫。**2026-10-11 实测：基线绿，10/10 被抓住、零存活**（每条红的具名用例见 `.spike/mutate-a2.log`），跑完逐条还原、还原后全套仍绿。g/h/i/j 这四条是**装配层守卫审计**（把 `plugins/**` 里每一处 `throw new Error(` 与断言它的用例对一遍）的产物——那条审计查出三条守卫当时**没有任何用例断言**，补齐用例后再加变异，见 `docs/交接文档.md`「②g」 |
| `.spike/mutate-token.mjs` | **审批层②h（空 Verification Token fail-closed）**的变异件（2 条，套件只取 `office-approval/callback-route.spec.ts`）：k 把 `handle()` 第一行那道 `verificationToken() === ''` 守卫改成 `if (false)`（＝删掉）／l 反转成 `!== ''`（＝配了密钥反而全拒）。**2026-10-11 实测：基线绿，2/2 被抓住**（k 红 2 例——正是这次新增的两条 fail-closed 用例；l 红 29 例——几乎所有走 `handle()` 的用例都依赖一个非空 token，这恰好说明「反转」不是无害改动）。纪律照 `mutate-a2.mjs`：一次一份、逐条快照还原、判据先去 ANSI、还原后复跑基线。⚠️ **这三条腿里的第三条（真进程观测）对本条不适用**：判定是 handler 内部的纯决策，且 D1 部署确实配了密钥 ⇒ 真进程只会重现「配了」那一臂；缺陷本身已在修之前用真代码量出来（空 token 时伪造的 approve 回调返回 **200** 并落账） |
| `.spike/u11-report.ts` | **自用验收周的 U11 量尺**（2026-10-11）：把审批台账变成几个可复读的数——按天/等级/状态/工具的分布、检索卡（`web_search`/`web_fetch`，全名精确匹配）占比、窗口内裁决三分桶（窗口内已批／超窗才批／还在等）、「同会话同参数最多问几次」（digest 用产品的 `argsDigest`，与 U9 卡片同源）。三条不可谈的取向：① **读经真 storage-domain**（`table('requests').entries()`，与 `ledger.requestsOf` 同一扇门，不自己剥 `{version,record}` 信封）；② **绝不静默丢行**——磁盘 `.json` 数≠读回记录数、台账目录不存在、窗口内 0 条这三种「不该被当成好消息的 0」都点名并以退出码 `1` 结束；③ **输出零正文**（`toolArgs`/`actionSummary`/`displayReason` 不落终端也不落 `--out`）。`--storage-root` **必填、绝不默认**（默认到 `~/.dsh` 就是宽读那棵带凭据的树）。跑法：`cd ../deepseek-harness && node --import tsx/esm "../apps/fom-client/.spike/u11-report.ts" --storage-root <storages 目录> [--since 2026-10-11] [--until 2026-10-18] [--json] [--out 文件]` |
| `.spike/selftest-u11.ts` + `.spike/mutate-u11.mjs` | 上面那把尺的自证与变异（2026-10-11）。自证件在 `fs.mkdtemp` 临时目录里用**真 `ApprovalLedger`** 落盘、再用**真 storage-domain** 读回，断言「读回再聚合的每个数与内存聚合逐字节相同」；**34/34 绿**（正向聚合 8／反向 9／真盘 9／正文零泄漏 3／CLI 5）。变异件 12 条（子串匹配、digest 不剔 `justification`、归组去掉 `sessionId`、分母换成全部记录、`0/0` 不兜底、不做形状判定、裁决分桶比错对象、工具名换成正文、丢行不进警告、空窗口报成功、目录不存在不报警、`--json` 当成吃值的键）⇒ **12/12 被抓住**。⚠️ 第一版近似名反例用 `search_web`，而 `'search_web'.includes('web_search')` 是 `false` ⇒ 子串变异**活下来**：那条断言当时是装饰。改名 `internal_web_search` 后同一变异红 4 条——反向语料要挑**真能区分两种写法**的数据，不是肉眼看着像反例。真进程腿对本条不适用（三条声明都能在临时盘上答完；「验收周读数」只能真人跑一周）。证据 `../docs/03-验证/U11检索卡占比量尺验证记录.md` |
| `session-query.spike.patch.yml` | **记忆层 §7 第 1 步**的挂载件（纯配置，无代码）：① 覆盖 `session-query-sqlite` 的 config 为 durable `path` + `openAt: first-search`（内核**已经挂着这个后端**，只是关成 `':memory'` + `never`，见 `packages/bundle/base/cordis.patch.yml:149-152` ⇒ **不是 insert**）；② 整行禁用 `preset-standard` 并插一份逐字副本、只多一行 `tool-session-query`（五把工具在任何发行 profile 里都没有组件行，web 按 **agent 名录**挂 ⇒ 落点是名录）。⚠️ 名录副本由 `.spike/make-session-query-patch.cjs` 从内核文件**文本拼接**生成，**别手抄**；⚠️ 名录按 `id` 匹配 ⇒ 只有选 `standard` 名录的会话拿得到这五把工具。跑法与四条判定的实测结果：`../docs/03-验证/M1记忆层spike记录.md` |
| `.spike/` | 第 7 步真进程的产物：卡片落盘、三张截图、两份 `--dump-config`、启动诊断、复现脚本（签名 POST / 窗口内批准 / 转储台账）；第 8 步的产物在同目录与 `.spike/feishu-ws/`（卡片形状探针、长连接桥接 `bridge.mjs` 与其 `events.jsonl`/`bridge.log`、信封形状离线核验 `envelope-check.mjs`、产品进程启动器 `run-feishu-loop.mjs`、卡片状态核验 `peek-card.mjs`）。审批层的变异检验跑法是 `node .spike/fe-mutation.mjs all`（**16 条变异**逐条改坏 `responder.ts` / `feishu-channel.ts` / `recovery.ts` / `risk-gate.ts`→只跑那四份 spec→从**当前**源码的快照还原→复跑基线；判定前先去掉 ANSI 色，否则 `×` 行匹配不到会把「跑不起来」误判成「变异活下来」。⚠️ 同一时间只能跑一份：两份并发会互相覆盖快照，还原时把新代码写回旧备份 —— 2026-10-10 实测踩到，见 `docs/03-验证/M1飞书联调冒烟记录.md` §7 索引；同一条坑的前半段是**别在半路读它的 stdout 日志**（没看到「还原后基线」那行就是还在跑，我据此误判过一次「被截断」而并发起了第二份）。**这些是 spike 输出，不是测试**（测试全在 `*.spec.ts` 里自给自足） |
| `plugins/office-approval/test-harness.ts` | 八份 spec 共用的插件组装（含 `schedule` 的桩）+ 真 agent/脚本化模型 + `boot({ approvalPolicy })`（E8 用）（不是 `*.spec.ts`，vitest 不收集它） |

设计与验收标准在 `../docs/02-设计/M1审批层设计v0.1.md`（审批层）与 `../docs/02-设计/M1记忆层设计v0.1.md`（记忆层，MF1–MF18 / DM / ME / MU），实测证据在 `../docs/03-验证/`。

## 跑测试

```powershell
cd "F:\deepseek\deepseek harness\apps\fom-client"
node ./node_modules/vitest/vitest.mjs run --no-file-parallelism   # 判绿用这条：277 个用例（18 份 spec = 审批层 9 份 183〔含 #33 的 compensate 半程失败一条，补进 recovery.spec；#38 的批件闸门两条，补进 sweeper.spec 与 ledger.spec；U10 的窗口内批准一致性四条，补进 callback-route.spec；U9 的「同一个动作重复询问」三条，补进 feishu-channel.spec；U8 的 never 会话 fail-closed 不变量一条，补进 responder.spec；**空 Verification Token 的 fail-closed 两条**〔伪造签名 / `url_verification` 不回显 challenge〕，补进 callback-route.spec；装配层两条，`index.spec.ts` 新文件——它是审批层**第一份真跑 `apply()` 的 spec**，其余八份都走 `test-harness.ts` 的手工组合〕 + 记忆层 9 份 94〔§7 第 2 步 4 份 35 + 第 3–4 步 2 份 18 + 第 5 步 2 份 21 + 第 6 步 A2 的 index/arm/risk-gate 三份 19：`index.spec.ts` 8 例＝装配 5 + 蒸馏入口默认导出 1 + `memoryRoot` 空值守卫 2，arm 7、risk-gate 4；其中 F-L 一例补进 tools.spec〕）
node ./node_modules/vitest/vitest.mjs run          # 快，但机器忙时会假红（见下）
node ../deepseek-harness/node_modules/typescript/bin/tsc --noEmit -p .
```

用例跑的是**真定时器**（没有 fake timers），8 份 spec 并行时会被机器负载拖到判定超时：2026-10-10 实测，产品进程还跑在 :3081 上时并行先红过 `recovery.spec.ts` 一例、再红过 `sweeper.spec.ts` 两例，两次红的**不是同一份**，`--no-file-parallelism` 串行 167 例全绿，红的那两份单独跑也全绿。看到真定时器用例红，先串行复跑再下结论。
另有一条同样只在忙时出现的坑：**变异检验（`.spike/fe-mutation.mjs`）一次只能跑一份**，它跑的时候别改那四份源文件、也别并行跑全套 spec —— 判据是「哪几条用例红了」，被别的进程同时改文件就会读到别人的中间态。

## 真实组合启动（§8 第 7 步的用法）

在 `../deepseek-harness` 仓库根目录执行（`--patch` 的 `name` 允许写路径，锚定到 patch 文件同目录）：

```bash
node --import tsx/esm apps/cli/src/bin.ts web \
  --patch "F:/deepseek/deepseek harness/apps/fom-client/office-approval.patch.yml" --no-open
```

挂载复核与就绪判据（都是实测）：

```bash
node --import tsx/esm apps/cli/src/bin.ts web --dump-config --patch "…/office-approval.patch.yml"   # 期望出现 id: office-approval 与整段 config
curl -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/office/approval/callback               # 405 = 我们的路由挂上了（GET 不收）
curl -i -X POST -d '{}' http://127.0.0.1:3080/office/approval/callback                              # 401 {"code":"missing-signature"} = 路由在会话鉴权之外，且没设 token 时谁都批不动
```

⚠️ 三条实测坑：**别用 `… | tee` 判活**（管道的退出码是 `tee` 的 0，会掩盖启动失败；端口被占时 `dsh` 真实退出码是 1）；
`/` 在未带 token 时**先答 404 再答 401**，不能用它判就绪；叠在后面的非 insert 覆盖行**整段替换 `config`**（不是深合并）。

**改 `risk-gate.ts` 里 `builtinRiskRules` 这张表之后，验收要在真进程里双侧打枪**（F-H 的教训：只证「不该问的不问了」正好是放宽的样子）：
负向 —— 发「先用 `todo_write` 给我记一条待办『X』，然后用 `ask_user_question` 问我晚饭吃什么（给两个选项）。不要读写文件，不要联网。」，
期望轨迹 tab 里两个工具**都真执行**、问题在 UI 里原生弹出原生回答、**台账 `requests/` 一条不多**、飞书一张卡都不发；
正向 —— 另起会话要求写一个工作区外的文件（明确「需要提权就正常发起提权，不要用工作区替代、不要绕沙箱」），
期望台账多出一条 `riskLevel=L3`、`actionSummary` 是人话（「写入 <路径>」而不是裸工具名）、`toolArgs` 里
`sandbox_permissions` 与 `justification` 成对存在，由真人点击在窗口内批准、`grants/` 仍为空、文件真落地。
两侧的逐字段实测证据见 `../docs/03-验证/M1飞书联调冒烟记录.md` §4.4。
逐条证据、真台账转储与四个缺陷的处置见 `../docs/03-验证/M1真实组合spike记录.md`。

## `node_modules` 是 junction，不是 install

`node_modules/@deepseek-ai/*`、`zod`、`vitest`、`@types/node` 全部是指向
`../deepseek-harness` 内已构建产物的目录 junction，**不要在这里 `pnpm install`**：

- 不装依赖就没有网络与版本漂移，内核升级后测试自动跟着走。
- Node 解析 junction 会落到真实路径，于是内核各包之间的 pnpm 依赖图原样生效 ——
  我们拿到的是**与运行中的 dsh 同一个模块实例**，`instanceof DomainError` 之类才成立。
- 链接指向各包的**目录本身**，包内 `package.json` 的 `exports` 再解析到 `lib/`（产品运行时加载的也是 `lib/`，不是 `src/`），
  所以内核改完要先在仓库里 build，这边才会看到新行为。

重建链接（PowerShell，无需管理员权限）：

```powershell
$H = 'F:\deepseek\deepseek harness\deepseek-harness'
$P = 'F:\deepseek\deepseek harness\apps\fom-client\node_modules\@deepseek-ai'
New-Item -ItemType Junction -Path "$P\cordis"             -Target "$H\vendor\cordis"
New-Item -ItemType Junction -Path "$P\schemastery"        -Target "$H\vendor\schemastery"
New-Item -ItemType Junction -Path "$P\dsh-storage"        -Target "$H\packages\storage\storage"
New-Item -ItemType Junction -Path "$P\dsh-storage-domain" -Target "$H\packages\storage\storage-domain"
New-Item -ItemType Junction -Path "$P\dsh-storage-json"   -Target "$H\packages\storage\storage-json"
# 风险闸的测试组合（§8 第 2 步）需要审批与工具运行时的真包
New-Item -ItemType Junction -Path "$P\dsh-llm"                 -Target "$H\packages\llm\llm"
New-Item -ItemType Junction -Path "$P\dsh-session"             -Target "$H\packages\core\session"
New-Item -ItemType Junction -Path "$P\dsh-session-projection"  -Target "$H\packages\session\session-projection"
New-Item -ItemType Junction -Path "$P\dsh-system-prompt"       -Target "$H\packages\core\system-prompt"
New-Item -ItemType Junction -Path "$P\dsh-agent"               -Target "$H\packages\core\agent"
New-Item -ItemType Junction -Path "$P\dsh-agent-loop"          -Target "$H\packages\core\agent-loop"
New-Item -ItemType Junction -Path "$P\dsh-user-approval"       -Target "$H\packages\interaction\user-approval"
New-Item -ItemType Junction -Path "$P\dsh-tools"               -Target "$H\packages\core\tools"
# 催办与过期（§8 第 6 步）要真 ScheduleService 与它的 ScheduleId
New-Item -ItemType Junction -Path "$P\dsh-schedule"            -Target "$H\packages\schedule\schedule"
New-Item -ItemType Junction -Path "$P\..\zod" -Target "$H\node_modules\.pnpm\zod@4.4.3\node_modules\zod"
```

`vitest` 与 `@types/node` 同理指向 `$H\node_modules\.pnpm\...` 下的对应目录。

> ⚠️ **批量建 junction 会静默失败，而且可能建错地方**：实测一条 PowerShell 循环里连建 8 个，只有 1 个真的落盘、
> `New-Item` 不报错，另有 7 个跑到了内核包目录里（`packages/core/agent-loop/dsh-dsh-agent` 这类）—— 那会污染内核工作树、
> 直接违反「内核零改动」。所以建完两步都要核：
> ① `fs.readdirSync` / `realpathSync` 逐个看链接（`test -d` 对不存在的路径也会打印出"看起来对"的字符串）；
> ② 在内核仓库跑 `git status --short`，除了预期的未跟踪文件（如 `office.patch.yml`）不该有任何新增。
> 删错名的 junction 用 `cmd /c rmdir "<路径>"` 或 node `fs.rmdirSync(p)`（对链接只删链接，不动目标）；
> `Remove-Item` 在这里抛 NullReferenceException，而 `rm -rf` 有可能顺着链接动到内核目录，不要用。

> **`office.patch.yml` 住在内核仓库根，git 管不到它**：所有 `--patch ./office.patch.yml` 都相对内核 cwd 解析（4 份 spike 脚本 + 十几处文档都这么写），所以那份实体只能留在 `deepseek-harness/` 根上；而 git **拒绝跟踪嵌套仓库里的文件**（`deepseek-harness/*` 加反向白名单实测无效，`git add` 只会把整个目录记成 gitlink＝伪子模块，已 `git rm --cached -f` 去掉）。本目录下的 `apps/fom-client/office.patch.yml` 是它的**入库副本**，只为「内核被重新 clone 后能一键复原」而存在，**不是**第二份实现——真起进程读的始终是内核根那份。改任何一边之后跑一次
> `cmp ../deepseek-harness/office.patch.yml office.patch.yml && echo SAME`，不等就把内核根那份覆盖过来再提交；漂了不会报错，只会让文档里的启动命令挂上一个已经变形的挂载件。

## 真飞书臂启动（§8 第 8 步的用法）

渠道从 `cardSink` 换成真飞书自建应用。**与上面那条 patch 二选一，不叠挂**（叠挂会踩「覆盖行整段替换 config」那条坑）：

```powershell
# 凭据只进子进程 env，不进命令行、不进 patch、不进 --dump-config
node .spike/run-feishu-loop.mjs 3081
# 等价的手工命令（在 ../deepseek-harness 下，注意 --patch 必须排在 --port 之前）
node --import tsx/esm apps/cli/src/bin.ts web `
  --patch "F:/deepseek/deepseek harness/apps/fom-client/office-approval.feishu.patch.yml" `
  --patch ./office.patch.yml --port 3081 --no-open
```

入站这一半走**长连接**（自建应用可以在开发者后台把事件订阅方式设成"使用长连接接收事件"，本机就不用公网回调）：

```powershell
node .spike/feishu-ws/bridge.mjs      # 飞书推来的 card.action.trigger → 包成公网回调那份信封 → 自签转投本地路由
```

四个实测事实（证据与坑逐条见 `../docs/03-验证/M1飞书联调冒烟记录.md`）：

1. **长连接不带飞书签名**，所以桥接转投时的 `x-lark-signature` 是我们自己算的。这条臂能证明真点击 / 真身份 /
   落账 / 唤醒，**不能**当作公网验签的证据。
2. **`EventDispatcher` 交给处理器的是拆掉外层的事件本体**（`operator`/`action` 在顶层），
   而路由的 `cardCallbackSchema` 认 `{schema, header, event}`。原样转投会被判「这个按钮的数据不完整」。
3. **`windowMs` 上限 600000**：调更大 ⇒ 整层装配失败（`ValidationError`），而不是悄悄回落默认值 —— 这正是想要的。
   真人冒烟用 600000/300000（10 分钟窗口、5 分钟催办）。
4. **送达判据是台账 `cards/<requestId>.json`**，不是 `GET /im/v1/messages`（那个索引有约 10 分钟延迟）。

## 记忆层启动（§7 第 2 步的用法）

写侧两工具的真进程验证。启动器每次先把 `.spike/memory-spike` 清空再起（残留条目会让「同 slug 已存在即跳过」探针失真）：

```powershell
node .spike/boot-step2.mjs 3083     # detached 起产品，轮询 callback 得 405 判就绪，token URL 写进 .spike/step2.url
node --import tsx/esm apps/cli/src/bin.ts web --dump-config `
  --patch "../apps/fom-client/office-approval.patch.yml" `
  --patch "../apps/fom-client/office-memory.spike.patch.yml" `
  --patch ./office.patch.yml         # 期望出现 id: office-memory 与 memoryRoot 整段 config
```

五臂观察（逐字工具 JSON 与返回、台账计数差见 `../docs/03-验证/M1记忆层第2步验证记录.md` §4）：记忆目录内 `memory_write` **零卡、真落文件**；`memory_archive` 先删索引行再 rename；junction 越界、绝对路径、`..` 穿越、feedback+external、命中 secret 五种越权/投毒全部被拒；工作区外的 `write` **照旧出一张 L3 卡**（没给自研工具开后门，§3.6 第 4 条）。

> ⚠️ 两条本机环境坑：**`cmd /c mklink /J` 在这个 Git Bash 里静默失败**（不报错也不建链接），junction 必须用 PowerShell `New-Item -ItemType Junction` 建并核 `LinkType`/`Target`（第 2 步第一臂就因此误判「feedback 写入成功」）；**残留的 dsh 实例会碰同一个台账目录**，读台账判出卡要用计数差 + 按 `sessionId` 过滤，别只认最新一条。

记忆层第 2 步的变异检验跑法与那 14 条（m13「把两行从字典删掉」必须同时红在静默侧与出卡侧）：`node .spike/mutate-memory.mjs`，逐条红测试见验证记录 §3 与 `.spike/mutate-memory.log`。⚠️ 同一时间只跑一份、日志等进程退出再读、期间别起产品。

## 记忆层注入段启动（§7 第 3–4 步的用法）

先 `node .spike/seed-memory.mjs` 种好 `.spike/memory-step3`（`MEMORY.md` + 条目 + 一行越界凭据），再 `node .spike/boot-step3.mjs 3084` 起进程（叠 `office-memory.spike3.patch.yml`，**不清空记忆目录** —— 磁盘上的 `MEMORY.md` 就是观察对象）。注入段挂在 `index.ts` 的同一个 apply 里，起进程即装段。五臂观察（逐字装配后 system prompt 与台账计数见 `../docs/03-验证/M1记忆层第3-4步验证记录.md` §4）：**装配时机这条设计闸在真进程关掉** —— 不重启、`MEMORY.md` 追加一行、下一回合模型凭常驻段逐字答出新事实且未 `read`；段里只呈现「标题+钩子+链接」（正文按需读），越界凭据那行**不进段**、`daily` 只记计数不落原文（ME7 注入半）；单写者/不虚构引导逐句在场；`memory_archive` 返回句已按 F-L 说清「索引由夜间蒸馏整段重写、别手动补」，真模型复述机制而没去手写 `MEMORY.md`。第 3–4 步变异（23 条，新增 m15–m23 覆盖注入三段、打分四条腿、F-L 返回句）仍用 `node .spike/mutate-memory.mjs`，纪律同上。

## 记忆层蒸馏核心（§7 第 5 步的用法）

第 5 步是**纯单测步**：蒸馏确定性核心（`distill.ts`）、对账台账（`run-ledger.ts`）、幂等武装（`arm.ts`）与 `store.ts` 扩展都还不在任何装配路径上（`index.ts` 的 `apply()` 未动，装进装配 + 双进程真组合是第 6 步）。验证三条：

```powershell
node ./node_modules/vitest/vitest.mjs run --no-file-parallelism        # 16 份 spec 242 例（新增 distill 14 + arm 7）
node ../deepseek-harness/node_modules/typescript/bin/tsc --noEmit -p . # 干净
node .spike/mutate-distill.mjs                                         # m24–m32：8/9 被抓住，m32 为等价变异（见下）
```

`distill.spec.ts` 的编排与台账用例跑**真临时目录 + 真 `storage-json` 后端**（`Storage → StorageJson → StorageDomain → open(memoryRunDomain)`，不 mock fs/后端），顺带证明 `office_memory_run` 这个下划线域名被内核接受。m32（`scanEntries` 去掉 `isFile()` 过滤）活下来是**如实的等价变异**：符号链接条目在下一层 `readEntry → locate → assertNoInternalLink` 已被拒（第 2 步 m1 钉死），该过滤只是纵深防御、不改变可观测行为。逐条红测试与第 6 步未做项清单见 `../docs/03-验证/M1记忆层第5步验证记录.md`。⚠️ 变异纪律照旧：一次一份、日志等进程退出再读、期间不起产品也别改那三份源文件。

## 双进程组合（§7 第 6 步：装配已收口，观测未跑）

上面那句「还不在任何装配路径上」到现在已经翻篇：蒸馏装进了 `apply()`，代价是**一个模块变成两份默认导出**——`index.ts` 是成员角色（两把工具、不注入 `schedule`），`distiller.ts` 是蒸馏角色（三把工具 + `storageDomain`/`schedule`/`sessions`，`--patch` 取的就是它的默认导出）。拆开的硬理由是 `inject` 的必需服务不能按 config 伸缩：不拆，成员进程也会去要一个它永远用不上的 `schedule`。

```powershell
node ./node_modules/vitest/vitest.mjs run --no-file-parallelism        # 18 份 spec 277 例
node ../deepseek-harness/node_modules/typescript/bin/tsc --noEmit -p . # 干净
node .spike/mutate-a2.mjs                                              # 10 条 a–j 全被抓住（字典 3 + 角色/武装 3 + 装配守卫 4）
node .spike/run-step6.mjs --dry-run                                    # exit 0：只排 patch 与预检，不起任何进程
cd ../deepseek-harness && node --import tsx/esm "../apps/fom-client/.spike/selftest-step6-baseline.ts" ../apps/fom-client/.spike/distill-workspace
                                                                        # 29 ✓ / exit 0：晚上落的基线能被早上那台判据机正确读回；①b 那条绝对锚钉住「哈希基准＝文件字节，不 trim、不解码」；⑨ 那五例钉「产品 store 写的那四个文件，生产端按同一路径读得回来」
cd apps/fom-client && node .spike/mutate-step6-baseline.mjs             # 13/13 抓住（日志 .spike/mutate-step6-baseline.log；d 现在只剩 ①b 那条锚抓得住，j–m 由 ⑨ 抓住）
cd apps/fom-client && node .spike/probe-step6-gap.mjs                   # ②s 的空缺取证（补 ⑨ 之前 j/k 完全静默）；与上一条别同时跑，两份都改同一个 .mjs
cd ../deepseek-harness && node --import tsx/esm "../apps/fom-client/.spike/selftest-verify-step6.ts" ../apps/fom-client/.spike/distill-workspace
                                                                        # 35 ✓ / exit 0：原有 26 项（判定层 10 + 夜间任务对账 16）+ ②r 那 9 项，正向与反向都在内
cd apps/fom-client && node .spike/mutate-step6-nightly.mjs              # 11/11 抓住（②p 第 5 枪；日志 .spike/mutate-step6-nightly.log）
cd apps/fom-client && node .spike/mutate-step6-readers.mjs              # 8/8 抓住（②r 差值两端共用读法；日志 .spike/mutate-step6-readers.log）
cd ../deepseek-harness && node --import tsx/esm "../apps/fom-client/.spike/selftest-probe-schedule.ts"   # 12 ✓ / exit 0（②q 收口探针的自证，全在临时目录，不读 .dsh）
cd apps/fom-client && node .spike/mutate-probe-schedule.mjs             # 8/8 抓住（②q；日志 .spike/mutate-probe-schedule.log）
cd ../deepseek-harness && node --import tsx/esm "../apps/fom-client/.spike/probe-schedule-shape.ts" "C:/Users/EDY/.dsh/storages/schedule.json"   # 观测当天内核真写出 daily 行之后收口；本机实测 exit 3＝还没有 daily 形
```

那一夜中间唯一的桥是 `.spike/step6-baseline.json`：启动器写、判据机读。原先**同一段算法写了两遍**（启动器内联产、判据机内联消费），而判据机的自证喂的是它自己手搓的基线对象 ⇒「启动器真落盘的那份 JSON 能不能被正确读回」零断言——桥断了不报错，只会让早上那张表把「还没发生」读成「被违反」。现在它抽成唯一生产者 `.spike/step6-baseline.mjs`（两边都 import，漂移由构造消除），并由上面那两条命令端到端钉住；抽取当场漂出两处会让那一夜作废的真漂移（手改靶路径写死、水位线缺失即 `ENOENT` 抛——后者会在两个各约 100s 的冷启动之后才崩），都已修。**②r 把同一个收口推进到另一端**：判据机 `observe()` 里原先也自写一套读法（手算 sha、自己筛 `.md`、靶路径自己拼），现在两端都 import 生产者的那五个函数，仪器分歧不再可能被报成产品行为变了。代价与补法都量过了——共用读法消掉了两端之间那份意外互检，所以另加了两条：**①b 绝对锚**（不经 `sha256File` 的算式钉住哈希基准）与 **`daily-readers-agree`**（拿产品自己的 `listDailyDays()` 当第二读者对账）；重跑同一份变异件实测 `d`（哈希先 `trim()`）只剩锚抓住（1 例红），`c`（日级留后缀）反而从 1 例红涨到 5 例红，就是被第二读者接住的。**②s 处理这一族的第三种形态**：生产端还硬编码着四个**归产品所有**的文件名（`daily/`、`daily/.watermark`、`daily/.distill-armed`、`MEMORY.md`），而 `.mjs` import 不到 `.ts`、为仪器给产品加导出＝为工具改产品 ⇒ 共享不了代码就共享**行为**（真 `MemoryStore` 落盘、生产端读，断言「两端说同一件事」；自证 24→**29 项 ✓**、变异 9/9→**13/13**）。动手前先用 `.spike/probe-step6-gap.mjs` 把空缺**量**出来：补之前那四个改名里**有两个完全静默**（红 0 条、exit 0），另两个只在起手态间接报红且归因指向「有一条 fail」而非「文件名错了」——**检测≠归因**，这条差别在观测当晚决定人是去核产品还是去核仪器。

这一半的证据与**没证据的部分**分得很清：ME8 现在是「构造性成立」（蒸馏进程不挂 `office-approval` ⇒ 没有可问的对象；`workspaceRoot=memoryRoot` ⇒ 写自家不 fence；`memory_distill` 登记 L1 ⇒ 真闸用例证了不打扰不落台账），**还不是**「实测零卡」——后者要整夜跑完取 `requests/` 的**文件名集合差值**（基线只记名字与哈希，台账正文一个字节都不进那张表）。七枪表与「本记录没证明什么」见 `../docs/03-验证/M1记忆层第6步验证记录.md`（§6 / §8）；**2026-10-11 已在真进程上跑完，结果与两处新发现见本文件末尾一节。**

上面那句「构造性成立」此前只核过「一份挂载件 + 一个搭档」的抄写形状，而启动器真正拼的是成员三件（approval + session-query + member）与蒸馏单件，两边还各叠内核侧两条 —— 能被后面这些 patch 用 `override` 改写的恰好就是 `sandbox-policy.workspaceRoot` 与 `session-query` 的 path。现已按启动器逐字列表两侧各 dump 一遍（命令在验证记录 §9）：成员臂 EXIT=0（`office-approval` 在表、`office-memory`→`index.ts`、**全表无 `distiller` 键**、`workspaceRoot` 仍是 `process.cwd()`），蒸馏臂 EXIT=0（`distiller.ts` + `distiller: true`、`memoryRoot`↔成员同路径且＝`workspaceRoot`、session-query `:memory:` ⇒ 两进程在 durable 索引上无碰撞面、**全表无 `office-approval`**）。日志 `.spike/dump-step6-{member,distill}-compose.log`。这仍然只是装配形状的证据。

## 记忆层 §7 第 6 步 · 真进程双侧观测结果（2026-10-11）

**怎么驱动**：不经浏览器，用观测件 `.spike/api-drive.mjs` 走 dsh web 的 `/api` Typert RPC（`GET /?token=<launchToken>` 换 authority 绑定的签名 cookie → `POST /api/session/create` → `POST /api/session/prompt`；wire 参数名按内核形参名逐字，猜错时网关 `gateway/arguments-invalid` 会精确报缺/多哪个）。两进程各按启动器真实 patch 列表起（成员 :3085 / 蒸馏 :3086），基线由启动器在两进程就绪之后落。

**收官判据**：`node --import tsx/esm "../apps/fom-client/.spike/verify-step6.ts" <seedDir> --baseline .spike/step6-baseline.json --cards-expected 2` ⇒ **`pass=12 fail=0 pending=1 info=1 ⇒ exit=3`**。全绿项含：ME8 零卡（新增 2 张卡**全归成员臂**、蒸馏 0）、`index-rebuilt`/`planted-ghost-gone`（ME10 整段重建、悬空行与凭据行都消失）、`watermark-advanced` + `dm8-idempotent`（DM8 水位线 + 第二次 `memory_distill` = `no-op`）、`hand-edited-untouched`（V2）、`no-secret-in-memory`（V4）、`daily-append-only`/`daily-readers-agree`、`nightly-job-single`、重启幂等（重启蒸馏进程后 nightly 仍 1 条、不堆叠）。`member-appended-daily` 判成 `pending` 的偏差见验证记录 §10.1（基线被进程启动时的注入留痕抢占了一天，**产品行为已发生**）。

**两处真进程才现形的问题（详见验证记录 §11）**：

- 🔴 **F-6A（严重，内核存储层）跨实例共享 `~/.dsh/storages/schedule.json` 的双向丢更新**：两个活着的 dsh 实例各持**启动快照**、任一侧写任务时整份重写 ⇒ 成员实例为审批卡写 `at` 行会**静默抹掉**蒸馏进程刚武装的 nightly `daily` 行（反向亦然、还会堆叠）。**✅ 已修（2026-10-12）**：启动器给蒸馏进程独立 `DSH_HOME`（`C:/Users/EDY/.dsh-distill`；`.spike/distill-home.mjs` 用 **junction（目录）+ hardlink（文件）** 把 `~/.dsh` 的 profiles/凭据等**共享引用**过来、唯独 `storages/` 是真目录，于是两边各写各的 `schedule.json`；不读凭据内容）。边界：硬链接要求与 `~/.dsh` **同卷**（都在 C:）。**复测**：成员写两条 `at` 行后**蒸馏 nightly 仍在**、重启不堆叠，收官 **`pass=14 fail=0 pending=0 info=0 ⇒ exit=0` 全绿**。
- 🟢 **F-6B（产品缺口）✅ 已修（2026-10-11）**：`session_search` 等五把 session-query 工具原未登记 `builtinRiskRules` ⇒ 落「未登记 → L4」默认 ⇒ **V6** 每次检索一张批准卡。修法＝把这五把只读本地检索工具（`packages/session-query/tool-session-query/src/index.ts:65-121`）登记 **L0**（与 `read`/`glob`/`grep` 同类）。**这是 F-H 的同类**：字典必须把**我们自己 `--patch` 挂进来**的工具也算进「完整覆盖」。验收＝具名用例 + `mutate-a2` k/l（**12/12 抓住**）+ 真进程双侧（负向 `session_search` **零卡** 45→45 且工具真执行 / 正向工作区外写照旧 1 张 `write` L3）；全套 **278 例**绿、`tsc` 干净。

## 飞书工具层（M1 收尾剩余，只读先行）

设计小样：`../docs/02-设计/飞书工具层设计小样v0.1.md`。**自研定名工具**（不是 MCP —— MCP 的 `mcp__<server>__<tool>` 名字运行时生成、字典故意不登记 ⇒ 落 L4 ⇒ 每次读都批卡）。

| 路径 | 内容 |
|---|---|
| `plugins/office-feishu/tools.ts` | `createFeishuTools(transport, tokens)`：**读 L0**——`feishu_doc_read`（读 docx 正文）/ `feishu_bitable_list_records`（列多维表格记录）/ `feishu_calendar_list_events`（列日历日程）；**写 L2**——`feishu_doc_create`（建 docx + 写文本块）/ `feishu_bitable_create_record`（新增记录）/ `feishu_calendar_create_event`（建日程）。`parseDocToken`/`parseBitableApp`/`parseBitableTable`/`parseCalendarId` 从链接或裸 id 取标识；复用审批层 `FeishuTransport` + `TokenSource`（token 失效码清缓存重试一次、成败看 `code`） |
| `plugins/office-feishu/index.ts` | 挂载入口：`feishuAppId` 空或配了 ID 却拿不到 Secret **都响亮抛**（同审批层取向）；复用 `createHttpFeishuTransport` + `createTenantTokenSource` |
| `plugins/office-feishu/tools.spec.ts` | 8 例：链接/裸 id 解析、GET raw_content + 鉴权、token 失效重试一次、业务码非 0 抛 `FeishuApiError`、缺参数 schema 拦、render 交正文 |
| `office-feishu.patch.yml` | 挂载件（`- insert:`；App ID 进 config、Secret 只给环境变量名）；`--dump-config` 静态核 **EXIT=0** |
| `.spike/mutate-feishu.mjs` | 4 条变异（字典行删→L4 / 不解析链接 / method 非 GET / 去掉 token 重试）⇒ **4/4 抓住** |

**风险字典**：`office-approval/risk-gate.ts` 登记 `feishu_doc_read: L0` + `risk-gate.spec.ts` 具名断言（F-H/F-6B 纪律：我们自己挂进来的定名工具也必须被断言）。`FeishuCall.method` 加了 `'GET'`（http 传输本就支持，只差类型）。

**状态**：**读 L0**（`doc_read`/`bitable_list_records`/`calendar_list_events`）真进程零卡；**写 L2**（`doc_create`/`bitable_create_record`/`calendar_create_event`）真进程：闸开各出 **1 张 L2 卡**（Arm A）、闸关真写入端到端（Arm B：建真文档回读 / 写记录 `reczz28MNiAz2H8L` / 建日程 `1f3635b1-…`）。`mutate-feishu` **18/18**；全套 **20 文件 307 例** / `tsc` exit 0。证据 `../docs/03-验证/飞书工具层只读切片验证记录.md`。

## 技能层（M1 收尾剩余）

自建 `SkillProvider`（形状抄内核 `skill-office`）把办公平台技能挂进 `ctx.skills`；技能正文是随包的 `assets/<name>/SKILL.md`。**不引入新工具、不放宽任何闸**——技能只是给模型的指令，调用的能力来自 `office-feishu` 与内核自带工具。（新增一条 junction：`@deepseek-ai/dsh-skill` → `deepseek-harness/packages/skill/skill`。）

| 路径 | 内容 |
|---|---|
| `plugins/office-skills/index.ts` | `createOfficeSkillsProvider(assetRoot)`：`list` 出候选、`get` 返回正文（剥 frontmatter）；两道守卫——`assetRoot` 必须绝对路径、挂载时 `SKILL.md` 必须在场（缺了响亮抛） |
| `plugins/office-skills/assets/meeting-minutes/SKILL.md` | 「会议纪要分发」技能正文：取原文（`feishu_doc_read`）→ 四段结构纪要（结论 / 待办含负责人+期限 / 遗留）→ 发布（`feishu_doc_create`）；纪律＝不编造、不代替决策、不落凭据 |
| `plugins/office-skills/assets/weekly-report/SKILL.md` | 「周报汇总」技能正文：取数（`feishu_bitable_list_records` + `feishu_calendar_list_events` + `read`/`grep`）→ 五段周报（概要 / 完成 / 进行中 / 下周计划 / 风险）→ 发布（`feishu_doc_create`） |
| `plugins/office-skills/index.spec.ts` | 5 例：list 两个候选、get 剥壳正文、相对 assetRoot 抛、SKILL.md 缺失抛、weekly-report 正文结构 |
| `office-skills.patch.yml` | 挂载件（`- insert:`）；`--dump-config` 静态核 EXIT=0 |
| `.spike/mutate-skills.mjs` | 3 条变异（去绝对路径守卫 / 去在场校验 / 不剥 frontmatter）⇒ **3/3 抓住** |

**状态**：单测 5 + 变异 3/3 + 静态核 EXIT=0 + **真进程发现/加载/端到端**（`meeting-minutes`：加载技能 → 出纪要 → `feishu_doc_create` ⇒ 1 张 L2 卡；`weekly-report`：加载 → 读多维表格〔L0 零卡〕→ `feishu_doc_create` ⇒ L2 卡）。证据 `../docs/03-验证/办公平台技能层验证记录.md`。

## 能力目录（L0，M2 前置 · P0）

把「平台预置的技能 / 专家 / 连接器」显式成一份**可被程序读**的只读目录——它是 M2 用户自管理界面（**L1**）的**数据源**。三层边界（L0 目录 / L1 用户自管理 / L2 运营后台）见 `../docs/02-设计/M2前置调研与设计草案v0.1.md` §2.5。**P0 只做目录 + 只读接口：不挂 UI、不做安装动作、不按 plan 差分。**

| 路径 | 内容 |
|---|---|
| `plugins/office-catalog/catalog.ts` | `CatalogEntry`/`CatalogSource`/`CatalogKind` 类型 + `DEFAULT_CATALOG`（深冻结）+ `validateCatalog`（id 前缀/重复/空字段）+ `createCatalogService`（只读 `list(kind?)`/`get(id)`/`validate()`，`list` 返回新数组）|
| `plugins/office-catalog/index.ts` | 插件壳：`apply` 用 `ctx.reflect.provide('officeCatalog', …)` 暴露只读服务，卸载时撤掉；无 `inject`、无 `Config`；`declare module` 声明 `Context.officeCatalog` 注入面 |
| `plugins/office-catalog/catalog.spec.ts` + `index.spec.ts` | 15 例：目录自检、三大类齐、深冻结、`list`/`get` 语义、`list` 返回新数组、校验抓重复 id/前缀错/缺字段、壳的提供与释放 |
| `office-catalog.patch.yml` | 挂载件（`- insert:`）；`--dump-config` 静态核 EXIT=0（`- id: office-catalog`）|

**状态**：单测 **15** + `tsc` exit 0 + 静态核 EXIT=0。**首版目录内容**：技能 5（`meeting-minutes` / `weekly-report` 自研 + `office-docx` / `office-pptx` / `office-xlsx` 内核）、连接器 1（`feishu`）、专家 1（`standard` 通用办公助手）。**未做**（P0 之外）：按 plan 的默认/允许集、开放策略、安装/启停动作、UI（L1）、运营后台（L2）。

## 最小只读 L1 界面（office-console，M2 前置 · P1 最小一步）

把 P0 的 L0 目录接到一个最小只读界面。**手写 JS 形态（路线 ①）**——正式 L1 应升级为 TSX + tsdown（路线 ②，见 `../docs/02-设计/前端技术栈与页面实现规范v0.1.md` §5）。数据流：浏览器面板 `fetch('/office/catalog')` ← host 只读路由 ← `officeCatalog` 服务（P0）。

| 路径 | 内容 |
|---|---|
| `plugins/office-console/index.ts` | host 面：`inject:['officeCatalog']`；经 `ctx.inject(['webServer'], …)` 等 webServer 就位后注册只读路由 `GET /office/catalog`（返回 `{version, entries}`）；`officeCatalog` 缺失时响亮抛 |
| `plugins/office-console/client.js` | 浏览器面（手写）：`main` 面板 + `sidebar.panellist` 入口；面板拉「目录 + `/office/console/state`(角色/启用态) + `/office/console/actions?role=`」，分组展示能力启用态 + **启停按钮**（`POST /api/office/console/action` 触发 `capability.toggle`，按 `decisions['capability.toggle'].allowed` 显隐） |
| `plugins/office-console/index.spec.ts` | 6 例：GET 200/JSON、非 GET 405、接线与释放、webServer 不在不抛、officeCatalog 缺失抛 |
| `office-console.patch.yml` | 挂载件（**须与 `office-catalog.patch.yml` 一起挂**，否则等不到目录服务） |
| `.spike/console-up.mjs` / `.spike/console-serve.mjs` | 起停 / 探针脚本 |

**状态**：单测 **6**（全套 **23 文件 328 例**绿）+ `tsc` exit 0 + 静态核 EXIT=0 + **真进程**：`GET /office/catalog` → 200（7 条）+ 本人浏览器实见侧栏「Office 控制台」与面板渲染。
**一个真进程才现形的坑**：第一版路由 404——`apply` 跑时 `officeCatalog` 服务已可见、但 **`webServer` 还没挂**（`ctx.get('webServer')===undefined`），`effect` 直接 no-op。修法＝`ctx.inject(['webServer'], …)` 等它就位（同内核 `ClientModuleRegistry`）。
**未做**（正式 L1 之前）：数据通道从自定义只读路由升级为 **Remote**；手写 JS → TSX + CSS Modules + tsdown。

## M2 A–D 阶段（地基 / 运维 / 路由 / 写决策）

按 `../docs/实施计划v0.1.md` 逐阶段落地。

| 路径 | 内容 |
|---|---|
| `plugins/office-authz/roles.ts` | **A1 · K-P0 授权矩阵**：`OfficeRole`×`OfficeAction`（`console.view`/`capability.toggle`/`bundle.install`/`bundle.remove`/`config.edit`/`skill.create`）；`can`/`requiresApproval`/`assertCan`/`validatePolicy`；**fail-closed**。依据 `控制台写操作权限设计v0.1.md` §2 |
| `plugins/office-authz/index.ts` | 插件壳：`ctx.reflect.provide('officeAuthz', {can,requiresApproval,assertCan})`；声明 `Context.officeAuthz` |
| `plugins/office-meter/{usage,reader}.ts` | **A2 · 计量（平台层 P0 / 成本 C-P0）**：`foldSessionUsage`（`assistant/message` 计、无 committed 的 `assistant/attempt` 补计，防两侧错）+ `mergeByDay` + `collectSessionsUsage`（读 `<home>/sessions`，**zstd 走 `node:zlib`**，同会话取最高代） |
| `plugins/office-ops/{backup,supervise,lock,orchestrate}.ts` | **B · O-P0**：`BACKUP_ENTRIES`/`DISPOSABLE_ENTRIES` + `backupHome`（O4 冷备）；`buildWebArgs`（`--patch` 排在应用旗标前，O1）+ `buildWebEnv`（注入 `DSH_HOME`，O3）+ `isReadyStatus`/`findWebUrl`（O8 就绪/地址）。**O-P1**：`acquireHomeLock`（**一 home 一活实例锁**）+ `planLaunches`（多租户启动规格）+ **`createSupervisor`（运行侧编排器：锁→spawn→探活→句柄 stop=杀+放锁；锁占用响亮抛、超时/失败杀+放锁）** |
| `plugins/office-router/{directory,wiring}.ts` | **C · R0 路由盖章**：`resolveContext(openId, tables)`（`open_id`→租户/角色→会话章，**fail-closed**）+ `ROLE_PRESET` + `identityNoticeFor` + `validateTables`；`wiring.ts`（`toSessionCreation`/`planSession`：会话章→创建计划 `{cwd,agentPreset,identityNotice}`）。⚠️ 真**入站适配器**（IM 消息→建会话）未实现，为 R0 真进程布线的前置。依据 `路由与权限模型设计v0.1.md` §3/§4 |
| `plugins/office-inbound/{inbound,feishu-map,session-port}.ts` | **C · 层①入站**：`handleInbound`（`open_id` 经 `planSession` 解析 → 未绑定 `unauthorized` 丢弃（fail-closed）/ 已绑定交给 `CreateSessionPort` 建会话 / 抛错 → `failed`）；`toInboundMessage`（飞书 event/信封 → `{openId,text}`，非文本丢弃）；`createKernelSessionPort`（结构化接内核 `create`）。⚠️ **长连接真实接入**随后 |
| `plugins/office-authz/actions.ts` | **D 核心 · 写操作三重防护决策**：`runConsoleAction`（授权 `can` 在先 → 高危未批 `needs-approval` → 否则才执行 `execute`；`forbidden`/`needs-approval` **绝不触碰执行体**）。依据 `控制台写操作权限设计v0.1.md` §2 |
| `plugins/office-console/actions-route.ts` | **D · 动作决策读端点**：`GET /office/console/actions?role=<role>` 返回该角色每动作 `{allowed,requiresApproval}`（读 `officeAuthz` 单一真相源）；console 现 `inject ['officeCatalog','officeAuthz']`，挂「目录 + 动作决策」两条只读路由 |
| `plugins/office-console/console-actions.ts` | **D · 写端点（认证 Fetch 路由）**：`createWriteFetch`（`(Request)=>Promise<Response>`；`done 200`/`needs-approval 202`/`forbidden 403`/执行失败 500）+ `createEchoExecutor`；console 经 `ctx.connection.fetch.register({path:'/api/office/console/action',methods:['POST'],requestBody:'buffered',…})` 挂到**共享 `/api` 通道**（内核按 `url.pathname` 精确匹配，`rpc-host.ts:135,139`；已通过信任+鉴权策略），**不用**无鉴权 `webServer` 路由；⭐ **安全：不信客户端 `role`/`approved`**——`role` 取服务端 `Config.operatorRole`（默认 owner、非法抛），`approved` 恒 false ⇒ 高危恒 `202`（fail-closed），真进程 `200/202/202/202` |
| `plugins/office-console/executor.ts` | **D · 真实执行体**：`createCapabilityStore`（启用态存储，从目录 `defaultEnabled` 播种）+ `createConsoleExecutor`（`capability.toggle` 翻转**真实状态**、`bundle.install/remove` 委托 `InstallerPort`（未注入则 **dry-run 不真装**）、`config.edit`/`skill.create` 接受） |
| `plugins/office-console/state-route.ts` | **D · 状态读路由**：`GET /office/console/state` 读回能力启用态（`webServer` 只读、非机密） |
| `plugins/office-console/approvals.ts` | **D · 服务端审批存储**：`ApprovalStore`（`request` 复用同载荷 pending / `grant` / `reject` / `consume` **一次性**核对「动作+载荷摘要」）。写端点：高危 → `202 + approvalId`；审批人 `approval.decide`（owner/admin）grant；带 `approvalId` 重试经服务端 `consume` 才 `200`；**重放即 `202`（已消费）** |
| `plugins/office-console/installer.ts` | **D · pluginManager 安装口**：`createPluginManagerInstaller`（结构化只取 `installBundle`/`removeBundle`）；由 `Config.enableInstaller`（**默认 false ⇒ dry-run**；真装＝root 等价须显式开启，开启但缺 `pluginManager` 服务则响亮抛） |
| `.spike/write-route-verify.mjs` | **D 真进程探针**：起实例带 cookie `POST /api/office/console/action`；验「非高危 200 / 高危 202 / 客户端伪造 role/approved 无效 / **服务端审批流**（202→decide grant→带 id 200→重放 202）」+ `GET /state` 状态真变 |
| `{office-authz,office-meter,office-ops,office-router,office-audit,office-observe,office-billing}.patch.yml` | 挂载件；`--dump-config` 静态核 EXIT=0 |

**状态**：单测 office-authz **17** + office-meter **13** + office-ops **22** + office-router **12** + office-console **45** + office-inbound **9** + office-audit **13** + office-observe **15** + office-billing **12**（全套 **55 文件 491 例**绿）+ `tsc` exit 0 + 各挂载件静态核 EXIT=0。

**未完**：A 的 **S-P0** 端到端纪律断言（依赖 D 的写操作/审批接线）；**O-P1 编排运行侧**（spawn/健康/重启的控制面循环）；R0 的**真进程布线**（把会话章接到入站适配器的会话创建窗口）；**D 的 Remote 通道**（裸路由 → SRC `@Remote` + `/api` 裸载体）与 console 写接线；**E–G**（E 的 P0 计量 / P1 审计 / P2 观测已完成，剩 P3 计费）。C 的 **U2**（渠道 app 形态）按最佳实践取「共享应用 + `open_id` 路由」。

## M2 E 阶段（平台化治理 · 审计 / 计量 / 观测 / 计费）

按 `../docs/02-设计/平台层设计v0.1.md`（控制面逐 home 读文件 → 折叠 → 存控制面自己的库）。

| 路径 | 内容 |
|---|---|
| `plugins/office-audit/audit.ts` | **E-P1 · 审计折叠**：`toAuditEntry`/`foldAudit`/`collectAudit` 把会话事件（`tool/call`、`tool/result`、`approval/asked`/`decided`、`hook/invoked`/`result`、`permission/preset`、`sandbox/mode`、`model/selection`、`turn/end`）归一化为 `AuditEntry`；`extractPaths` 从 `tool/call.arguments` **尽力**抽 `file_path`/`path`（文件访问审计的最小信号，P7：内核不落文件读；完整 diff 埋点＝U5 未做）。记录来自磁盘 ⇒ 字段一律运行时校验 |
| `plugins/office-audit/store.ts` | **E-P1 · 审计索引**：`createAuditStore`（按 `{tenant,sessionId,seq}` **去重**防轮询重复计；按 `tenant`/`kind`/`type`/时间窗/`limit` 查询；JSONL 导出，按 `(time,seq)` 升序） |
| `plugins/office-audit/index.ts` | 插件壳：`ctx.reflect.provide('officeAudit', {collect,collectMany,createStore})`；读法**复用** `office-meter/reader.ts` 的 `readSessionLogs` |
| `plugins/office-observe/observe.ts` | **E-P2 · 观测指标**：`approvalLatency`（审计 `approval/asked`→`decided` 配对算等待时长，跨会话同 `id` 不配对，未决计 `pending`）+ `failureStats`（`tool/result` `ok` 占比 + `errorCode` 分桶 + `turn/end` reason 直方图）+ `buildSnapshot`（合并计量 `byDay` + 指标） |
| `plugins/office-observe/health-route.ts` | **E-P2 · 自建健康端点**：`GET /health`（内核无内置，P8）；`ok→200` / `degraded→503` / 非 GET `405` |
| `plugins/office-observe/index.ts` | 插件壳：`inject ['officeMeter','officeAudit']` → `officeObserve` 服务 + `webServer` 挂 `/health`（缺服务**响亮抛**） |
| `plugins/office-billing/pricing.ts` | **E-P3 · 计费折算**：自建 `PriceTable`（`ModelPrice` 每百万 token 单价）+ `resolvePrice`（表内/兜底/**未定价**）+ `costOf`（输入/缓存读/缓存写/输出分桶折算；缓存单价缺省 = 输入）。内核不读 cost（P2）⇒ 价格表必须自建 |
| `plugins/office-billing/quota.ts` | **E-P3 · 限额裁决**：`QuotaLimits`（token/金额/调用次数）+ `evaluateQuota`（逐维判超、含端点不超）+ `OverageAction`（`warn`/`reject`/`downgrade`，**默认 `warn`**＝U3 未定取最保守） |
| `plugins/office-billing/index.ts` | 插件壳：`officeBilling` 服务（`cost`/`total`（未定价**不静默按 0**、列出 `unpriced`）/`quota`）；`Config`＝`currency`+`prices`(`z.dict`)+`overageAction`（非法**响亮抛**） |

**状态**：office-audit **13**、office-observe **15**、office-billing **12**；E 阶段门禁随全套 **55 文件 491 例**绿 / `tsc` exit 0；`office-{audit,observe,billing}.patch.yml` 静态核 EXIT=0（observe 挂载件须同挂 meter+audit）。

**未完**（E 余项）：**告警规则**（阈值触发，控制面自建）；**成本**（辅助单路由便宜模型 + 挂 `spill`/`pruner`）；**安全**（外部内容围栏 / 出网控制 / 日志脱敏 / 供应链）；文件访问的**数据面埋点**（记路径→记 diff，U5；本轮只做到从 `tool/call` 尽力抽路径）。**另**：控制面服务端本体（采集循环 + 租户注册表 + 平台 API + 常驻编排）尚未落地（当前这些服务只在数据面进程内被调用）。


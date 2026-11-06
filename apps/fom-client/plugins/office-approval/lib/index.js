// apps/fom-client/plugins/office-approval/index.ts
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import z3 from "@deepseek-ai/schemastery";
import { SessionId as SessionId2 } from "@deepseek-ai/dsh-session";

// apps/fom-client/plugins/office-approval/ledger.ts
import { createHash } from "node:crypto";
import { z } from "zod";
import { defineDomain, domainTable } from "@deepseek-ai/dsh-storage-domain";
var approvalStatuses = ["pending", "approved", "rejected", "expired", "recalled", "consumed"];
var riskLevels = ["L0", "L1", "L2", "L3", "L4"];
var requestSchema = z.object({
  requestId: z.string(),
  sessionId: z.string(),
  callId: z.string().optional(),
  rootCallId: z.string().optional(),
  tenantId: z.string(),
  toolName: z.string(),
  riskLevel: z.enum(riskLevels),
  actionSummary: z.string(),
  /** 取自 `tools/pre-execute` 的 `exec.arguments` —— 内核的审批事件里没有参数（F4）。 */
  toolArgs: z.unknown(),
  /** 透传给卡片的原文，responder 不重组（D8）。 */
  displayReason: z.string(),
  status: z.enum(approvalStatuses),
  askedAt: z.number(),
  windowEndsAt: z.number(),
  expiresAt: z.number(),
  decidedBy: z.string().nullable(),
  decidedAt: z.number().nullable()
});
function isDecidable(record, at) {
  if (record.expiresAt <= at) return false;
  return record.status === "pending" || record.status === "expired" || record.status === "recalled";
}
function awaitsDecision(record, at) {
  if (record.status === "pending") return true;
  return (record.status === "expired" || record.status === "recalled") && record.expiresAt > at;
}
function awaitsExpiry(record) {
  return record.status === "pending" || record.status === "expired" || record.status === "recalled" || record.status === "approved";
}
var grantSchema = z.object({
  grantId: z.string(),
  requestId: z.string(),
  toolName: z.string(),
  argsDigest: z.string(),
  consumes: z.number().int().default(1),
  grantedAt: z.number(),
  grantExpiresAt: z.number()
});
var callIndexSchema = z.object({
  callId: z.string(),
  requestId: z.string()
});
var denialReasons = ["not-approver", "approvers-unresolvable", "tenant-mismatch"];
var denialSchema = z.object({
  denialId: z.string(),
  requestId: z.string(),
  tenantId: z.string(),
  /** 尝试者，不是决策者 —— 这一行的存在不代表任何决定。 */
  openId: z.string(),
  at: z.number(),
  reason: z.enum(denialReasons)
});
var cardSchema = z.object({
  requestId: z.string(),
  /** 一条审批可能推给多个审批人，每个人一条消息 —— 改字/撤回要逐个打，句柄只能是列表。 */
  messageIds: z.array(z.string()),
  recipientIds: z.array(z.string()),
  pushedAt: z.number()
});
var sweepKinds = ["remind", "expire"];
var sweepStatuses = ["armed", "fired", "cancelled"];
var sweepSchema = z.object({
  sweepId: z.string(),
  requestId: z.string(),
  kind: z.enum(sweepKinds),
  at: z.number(),
  /** 告警层的 job id；`null` = 登记了但还没武装成功（此时撤销只需删掉这一行）。 */
  alarmId: z.string().nullable(),
  status: z.enum(sweepStatuses),
  armedAt: z.number(),
  firedAt: z.number().nullable()
});
var approvalLedgerDomain = defineDomain({
  name: "office_approval_ledger",
  version: 1,
  layout: "per-record",
  tables: {
    requests: domainTable(requestSchema),
    grants: domainTable(grantSchema),
    call_index: domainTable(callIndexSchema),
    denials: domainTable(denialSchema),
    cards: domainTable(cardSchema),
    sweeps: domainTable(sweepSchema)
  }
});
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const source = value;
    const out = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalize(source[key]);
    return out;
  }
  return value;
}
function argsDigest(args) {
  const authorized = canonicalize({ ...args, justification: void 0 });
  return createHash("sha256").update(JSON.stringify(authorized)).digest("hex");
}
var ApprovalLedger = class {
  constructor(domain, options = {}) {
    this.domain = domain;
    this.options = options;
  }
  #listeners = /* @__PURE__ */ new Set();
  get requests() {
    return this.domain.table("requests");
  }
  get callIndex() {
    return this.domain.table("call_index");
  }
  get grants() {
    return this.domain.table("grants");
  }
  /** 拒绝尝试是只追加的审计流，产品侧不做按 `requestId` 的查询，所以不建索引表。 */
  get denials() {
    return this.domain.table("denials");
  }
  /** 落一条新请求。后端写失败时这里 reject，且内存里不会留下半个状态（E12）。 */
  async create(request) {
    await this.requests.put(request.requestId, request);
    this.#notify(request.requestId);
    return request;
  }
  /**
   * ask 快照：记录 + `callId → requestId` 索引。
   *
   * 必须落在闸这一侧：内核的审批事件只有 6 个字段，**没有工具参数**（F4），
   * 而 §3.4.1② 要求快照取自「即将被闸的那次调用」—— 只有 `tools/pre-execute`
   * 这一刻看得到 `exec.arguments`。索引表是因为 responder 手上只有 `callId`，
   * 而台账主键是不可猜的 `requestId`。
   *
   * 索引写失败时 best-effort 收回记录再 reject，让 risk-gate 走拒绝路径（E12）。
   * 收回也可能失败（后端整体坏了），那时留下一条没人认领的 pending —— 它是惰性的：
   * 没有对应的询问在飞，也**不会**有催办告警被武装（状态变更通知排在两次写都落完之后才发），
   * 最坏是在审计导出里多一行。
   */
  async snapshot(request) {
    await this.requests.put(request.requestId, request);
    if (request.callId === void 0) {
      this.#notify(request.requestId);
      return request;
    }
    try {
      await this.callIndex.put(request.callId, { callId: request.callId, requestId: request.requestId });
    } catch (error2) {
      await this.requests.delete(request.requestId).catch(() => {
      });
      throw error2;
    }
    this.#notify(request.requestId);
    return request;
  }
  /** responder / 回调路由靠它把内核带来的 `callId` 换回台账主键。 */
  findByCall(callId) {
    const index = this.callIndex.get(callId);
    return index === void 0 ? void 0 : this.requests.get(index.requestId);
  }
  get(requestId) {
    return this.requests.get(requestId);
  }
  /** 拒绝尝试落审计（E5）。只追加，绝不改动 `requestId` 那条记录的状态。 */
  async recordDenial(denial) {
    await this.denials.put(denial.denialId, denial);
  }
  denial(denialId) {
    return this.denials.get(denialId);
  }
  get cards() {
    return this.domain.table("cards");
  }
  get sweeps() {
    return this.domain.table("sweeps");
  }
  /**
   * 记一张已送达卡片的句柄（§8 第 6 步）。
   *
   * 覆盖写是有意的：同一 `requestId` 的催办重推会换 `messageId`，而"当前能改的那张卡"
   * 只能有一个 —— 旧句柄对应的消息由渠道自己撤回，不在这里留两个指向。
   */
  async putCard(handle) {
    await this.cards.put(handle.requestId, handle);
  }
  cardHandle(requestId) {
    return this.cards.get(requestId);
  }
  /**
   * 一个会话的全部审批记录 —— 卡片上的「本次会话第 N 次放宽权限」次数靠它数出来（§4 人因防线）。
   * 这是唯一允许把台账当只读聚合查询用的地方：它不参与决策，只把已经落账的事实呈现给人。
   */
  requestsOf(sessionId) {
    return [...this.requests.entries()].map(([, record]) => record).filter((record) => record.sessionId === sessionId);
  }
  /**
   * 重启后还要补登记催办/作废的两类记录：
   * - 仍欠裁决的（`pending`，以及 `expiresAt` 之前转后台的 `expired` / `recalled`）→ 催办 + 作废都欠；
   * - `approved` 且没被重放消费掉的 → 只欠作废（催办会打扰已经批了的人）。
   */
  openRequests(now) {
    return [...this.requests.entries()].map(([, record]) => record).filter((record) => awaitsDecision(record, now) || record.status === "approved");
  }
  /** 台账状态变更订阅点；返回撤销句柄。 */
  onChanged(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  #notify(requestId) {
    if (this.#listeners.size === 0) return;
    const record = this.requests.get(requestId);
    if (record === void 0) return;
    for (const listener of [...this.#listeners]) {
      try {
        listener(record);
      } catch (error2) {
        this.options.onObserverError?.(error2, record);
      }
    }
  }
  /**
   * 登记一次告警武装。返回 `false` = 这一条已经登记过，调用方**不该**再去落第二个定时器。
   *
   * 内存预判 + 主键覆盖写：这一对挡不住两个并发 `arm` 都看到"没登记过"的极端时序，
   * 但那一时序的后果被消费侧的 `claimSweep` 吃掉（多出来的告警到点只会被记为已消费一次，
   * 第二次拿到 `false`），所以这里不必再加一层排队闸 —— §3.6 的取向是幂等消费，不是分布式原子性。
   */
  async armSweep(sweep) {
    if (this.sweeps.get(sweep.sweepId) !== void 0) return false;
    await this.sweeps.put(sweep.sweepId, sweep);
    return true;
  }
  sweep(sweepId) {
    return this.sweeps.get(sweepId);
  }
  sweepsOf(requestId) {
    return [...this.sweeps.entries()].map(([, row]) => row).filter((row) => row.requestId === requestId);
  }
  /** 还在武装的告警行 —— 投递对账靠它把 job id 换回登记行。 */
  armedSweeps() {
    return [...this.sweeps.entries()].map(([, row]) => row).filter((row) => row.status === "armed");
  }
  /**
   * 这条审批还留着**一张没被消费掉的批件**吗。
   *
   * §3.5 在 `approved` 上留下 `expire` 告警的**唯一**理由，是要在 `expiresAt` 收回一张
   * 「批了却永远没被重放」的批件（安全阀）。同步窗口内的批准从不落批件、重放成功后批件即被删，
   * 这两种 `approved` 都没有可收回的东西 —— 此时武装/留着 `expire` 不只是白挂一条侧栏自动化，
   * 而是到点会把一条**已完成**的批准误判成作废（状态被改、发起人收到「因未获批准，任务未完成」）。
   * 作废这条动作因此只能认「有没有批件」，不能只认状态。
   */
  hasOutstandingGrant(requestId) {
    for (const [, grant] of this.grants.entries()) {
      if (grant.requestId === requestId) return true;
    }
    return false;
  }
  /**
   * 放弃一次**还没武装成功**的登记（`alarmId` 还是 `null`）—— 让下一次扫描能重试。
   *
   * 已有 job id 的行不走这条路：那是要撤销的告警，删掉就丢了"曾经武装过"的痕迹，
   * 而且告警层可能已经把这个 id 记在别处，撤销必须走 `cancelSweep` 拿到 id。
   */
  async forgetSweep(sweepId) {
    const current = this.sweeps.get(sweepId);
    if (current === void 0 || current.alarmId !== null) return;
    await this.sweeps.delete(sweepId);
  }
  /** 告警层拿到了它自己的 job id 之后回填登记（写链上的 `update`）。 */
  async attachAlarm(sweepId, alarmId) {
    await this.sweeps.update(sweepId, (current) => ({ ...current, alarmId }));
  }
  /**
   * 认领一次到期（幂等消费）：只有把 `armed → fired` 赢下来的那一次才该去做重推/作废动作。
   * 内核 `schedule` 明确"崩溃与提交之间不保证恰好一次"，所以同一条告警可能被交到两次。
   */
  async claimSweep(sweepId, at) {
    if (this.sweeps.get(sweepId)?.status !== "armed") return false;
    let won = false;
    await this.sweeps.update(sweepId, (current) => {
      if (current.status !== "armed") return current;
      won = true;
      return { ...current, status: "fired", firedAt: at };
    });
    return won;
  }
  /**
   * 撤销登记：决策已定，之后的告警一律不该再动作。
   *
   * `fired` 的行**不回滚** —— 它是一次已经发生的事件，改掉它等于抹掉"我们催过办"这条审计；
   * 只把还武装着的行标成 `cancelled` 并把 job id 交给调用方去删。
   */
  async cancelSweep(sweepId) {
    const current = this.sweeps.get(sweepId);
    if (current === void 0 || current.status !== "armed") return void 0;
    let alarmId;
    await this.sweeps.update(sweepId, (row) => {
      if (row.status !== "armed") return row;
      alarmId = row.alarmId ?? void 0;
      return { ...row, status: "cancelled" };
    });
    return alarmId;
  }
  /**
   * 带守卫的状态迁移，返回**本次是否赢**。同一 `requestId` 的第二次点击必然 false（E4）——
   * 重复回调、多人同批、用户连点都在这一层挡掉。
   */
  async transition(requestId, guard) {
    const won = await this.#migrate(requestId, guard);
    if (won) this.#notify(requestId);
    return won;
  }
  /**
   * 迁移的**不通知**内核：写链上的权威判定与 `transition` 完全一致，只是不发状态变更通知。
   *
   * 单独拆出来只为一处 —— `approve` 必须让订阅者看到「批件已经落好」的 `approved`，
   * 而 `transition` 会在写批件之前就把通知发出去。催办订阅靠「有没有批件」决定 `expire` 去留
   * （`hasOutstandingGrant`），若在批件落账前通知，同步批准与迟到批准在这一刻看起来一模一样，
   * 订阅者就没法区分、只能一律留着 `expire` —— 那正是 #38 的幽灵自动化。
   */
  async #migrate(requestId, guard) {
    const current = this.requests.get(requestId);
    if (current === void 0 || !guard.from.includes(current.status)) return false;
    let won = false;
    await this.requests.update(requestId, (record) => {
      if (!guard.from.includes(record.status)) return record;
      won = true;
      return { ...record, status: guard.to, ...guard.set };
    });
    return won;
  }
  /**
   * 批准并授权一次重放（D7）。
   *
   * 先迁状态再写 grant；grant 写失败（E12）就把状态退回 `expired` 作为补偿 ——
   * `expired` 仍在 `approve` 的可迁移集合里，所以用户重新点一次仍能成功，
   * 而不是留下一条「已批准但永远等不到授权」的死账。
   */
  async approve(requestId, input) {
    const won = await this.#migrate(requestId, {
      from: ["pending", "expired", "recalled"],
      to: "approved",
      set: { decidedBy: input.decidedBy, decidedAt: input.now }
    });
    if (!won) return { won: false };
    const grant = {
      grantId: input.grant.grantId,
      requestId,
      toolName: input.grant.toolName,
      argsDigest: input.grant.argsDigest,
      consumes: 1,
      grantedAt: input.now,
      grantExpiresAt: input.grant.grantExpiresAt
    };
    try {
      await this.grants.put(grant.grantId, grant);
    } catch (error2) {
      await this.transition(requestId, { from: ["approved"], to: "expired" });
      throw error2;
    }
    this.#notify(requestId);
    return { won: true, grant };
  }
  /**
   * 收回一张还没用掉的批件。
   *
   * 两个调用方都需要它，而且都是安全要求而不是清理：
   * ①批准由还在等的同步窗口当场兑现（动作这一轮就执行），批件若留着，之后任何一次
   * 同工具同参数的调用都会不问自取地执行；②会话唤醒失败时先把批件收回，再把记录
   * 退回可批准状态，用户重新点一次仍能成。
   *
   * 删除与「消费完即删」是同一条路径，不额外破坏审计：批件存在过的事实由
   * `requests` 那条记录的 `approved` 状态与 `decidedBy` 承载。
   */
  async revokeGrant(grantId) {
    await this.grants.delete(grantId);
  }
  /**
   * 收回某条审批留下的、还没被重放消费掉的批件（§3.5 的「审批作废 ⇒ grants 不再受理」）。
   *
   * 消费侧本来就有 `grantExpiresAt` 这道门，所以这一步不是安全边界，而是审计卫生：
   * 作废之后账上还躺着一张能用的批件，导出报表的人会问"这条到底能不能执行"。
   * grant 的 id 是批准时生成的随机值，所以按 `requestId` 反查 —— 授权发放时记的是哪条审批。
   */
  async revokeGrantsFor(requestId) {
    const stale = [...this.grants.entries()].filter(([, grant]) => grant.requestId === requestId).map(([grantId]) => grantId);
    for (const grantId of stale) await this.grants.delete(grantId);
    return stale.length;
  }
  /**
   * 消费一次授权：digest 失配（E9）或已过期（E10）都返回 undefined，调用方回落标准询问。
   * 守卫同样写在 fn 里，所以两个重放 turn 并发消费同一 grant 只会赢一个。
   */
  async consumeGrant(toolName, digest, now) {
    const candidates = [...this.grants.entries()].filter(([, grant]) => grant.toolName === toolName && grant.argsDigest === digest && grant.consumes > 0 && grant.grantExpiresAt > now).sort(([, a], [, b]) => a.grantedAt - b.grantedAt);
    for (const [grantId] of candidates) {
      let consumed;
      const next = await this.grants.update(grantId, (current) => {
        if (current.consumes < 1 || current.grantExpiresAt <= now) return current;
        consumed = { ...current, consumes: current.consumes - 1 };
        return consumed;
      });
      if (consumed === void 0) continue;
      if (next.consumes === 0) await this.grants.delete(grantId);
      return next;
    }
    return void 0;
  }
};

// apps/fom-client/plugins/office-approval/risk-gate.ts
import { randomUUID } from "node:crypto";
function escalated(args) {
  return args.sandbox_permissions !== void 0;
}
function classifyFile(filePath, permissions) {
  if (permissions !== void 0) return "L3";
  if (filePath !== void 0 && /(^|[\\/])outbox[\\/]/.test(filePath)) return "L2";
  return "L1";
}
var builtinRiskRules = {
  // 只读，L0：`packages/fs/tool-fs/src/read.ts:78`、`tool-fs-search/src/{glob.ts:307,grep.ts:285}`
  read: { level: "L0" },
  glob: { level: "L0" },
  grep: { level: "L0" },
  // 会话历史检索五把（`packages/session-query/tool-session-query/src/index.ts:65-121`，全部只读：
  // 搜历史会话 / 搜单会话事件 / 读会话谱系 / 读事件替换链 / 读单条完整事件），无写盘、无出网、无外部动作。
  // F-6B：这五把不在 dsh web 默认 profile，是我们用 `--patch` 挂进来的 —— 补这一组的动机与 F-H 同源：
  // 不登记就落「未知 → L4」，模型一调 `session_search` 引记忆出处就要一张 owner 批准卡（自动化下无人应答、
  // 工具从不执行）。只读本地检索与 `read`/`glob`/`grep` 同类，故是 L0 而非 L1/L2。
  session_search: { level: "L0" },
  session_event_search: { level: "L0" },
  session_trace: { level: "L0" },
  session_event_trace: { level: "L0" },
  session_event_read: { level: "L0" },
  // 飞书工具层（`plugins/office-feishu/tools.ts`，设计小样 §2）：只读飞书文档 = 本地不可见、无外部副作用 = L0。
  // F-6B 同类：这把我们自己挂进来的**定名**工具若不登记就落「未登记 → L4」（每次读都批一张卡）；
  // 走自研定名工具而不是 MCP，正是为了能静态登记（MCP 的 `mcp__<server>__<tool>` 名字运行时生成、无法登记）。
  feishu_doc_read: { level: "L0" },
  // 列出多维表格记录 = 只读（本地不可见、无外部副作用）= L0。
  feishu_bitable_list_records: { level: "L0" },
  // 列出日历日程 = 只读 = L0。
  feishu_calendar_list_events: { level: "L0" },
  // 写飞书文档 = 对外可见 = L2（与 `web_search` / `schedule_create` 同档；写工具会问人批准）。
  feishu_doc_create: { level: "L2", summarize: (args) => `\u65B0\u5EFA\u98DE\u4E66\u6587\u6863\u300C${args.title ?? ""}\u300D` },
  // 写多维表格记录 / 建日历日程 = 对外可见 = L2。
  feishu_bitable_create_record: { level: "L2", summarize: () => "\u5F80\u591A\u7EF4\u8868\u683C\u5199\u4E00\u6761\u8BB0\u5F55" },
  feishu_calendar_create_event: { level: "L2", summarize: (args) => `\u5EFA\u65E5\u5386\u65E5\u7A0B\u300C${args.summary ?? ""}\u300D` },
  // 读图会把图存进本会话附件（`tool-fs/src/read-image.ts:210`），是幂等的会话内写，不是纯读。
  read_image: { level: "L1" },
  // 问人本身（`packages/interaction/tool-ask-user/src/{index.ts:39,timed.ts:107}`，两个实现同名）：
  // 纯 UI 往返，不写盘、不出网。F-H 的回环就是这一条 —— 它必须登记，否则「先获批才能问要不要批」。
  ask_user_question: { level: "L0" },
  // 读自身状态（`tool-jobs/src/index.ts:311,352`、`tool-goal/src/index.ts:196`、
  // `tool-schedule/src/index.ts:484`、`tool-subagent-control/src/list-agents.ts:87`、
  // `mcp-resources/src/tools.ts:34,43`、`tool-skill/src/index.ts:82`）
  job_output: { level: "L0" },
  job_list: { level: "L0" },
  get_goal: { level: "L0" },
  schedule_list: { level: "L0" },
  list_agents: { level: "L0" },
  list_mcp_resources: { level: "L0" },
  list_mcp_resource_templates: { level: "L0" },
  // 载入 SKILL.md 会把指令注进上下文（`tool-skill/src/index.ts:82`），但那是操作者装好的本地文件，
  // 不产生外部动作，所以是只读而不是审批对象。
  skill: { level: "L0" },
  // 会话内状态写：todo 投影（`tool-todo/src/index.ts:136`）、交付物声明（`tool-present/src/index.ts:39`）、
  // goal 状态（`tool-goal/src/index.ts:208,235`）—— 幂等、可覆盖、自己不会发起任何动作。
  todo_write: { level: "L1" },
  present: { level: "L1" },
  create_goal: { level: "L1" },
  update_goal: { level: "L1" },
  // 退出计划模式本身就是「把计划交给人看」的那一步（`packages/plan/plan-mode/src/index.ts:66`）。
  // 再给它叠一张审批卡，就是问人要两次同一个决定 —— 与 ask_user_question 同一类回环。
  exit_plan_mode: { level: "L1" },
  // 文件写与 shell：按参数二次判定（§3.4.1②）。
  write: {
    level: (args) => classifyFile(args.file_path, args.sandbox_permissions),
    summarize: (args) => `\u5199\u5165 ${args.file_path ?? "?"}`
  },
  edit: {
    level: (args) => classifyFile(args.file_path, args.sandbox_permissions),
    summarize: (args) => `\u7F16\u8F91 ${args.file_path ?? "?"}`
  },
  // `packages/shell/tool-bash/src/index.ts:375`、`tool-pwsh/src/index.ts:385`：任意命令执行。
  bash: { level: (args) => escalated(args) ? "L3" : "L2", summarize: () => "\u6267\u884C\u547D\u4EE4" },
  pwsh: { level: (args) => escalated(args) ? "L3" : "L2", summarize: () => "\u6267\u884C\u547D\u4EE4" },
  // 出网：查询词与 URL 都会离开这台机器（`packages/web/tool-web/src/{search.ts:326,fetch.ts:457}`）。
  // 按 §5「对外可见」是 L2。**这是一条会被日常使用感质疑的判定**，见设计 §9 U11：
  // 想让它不打扰，正确出路是聚合审批（U6）或显式白名单配置，而不是把它悄悄写回 L0。
  web_search: { level: "L2", summarize: (args) => `\u8054\u7F51\u68C0\u7D22 ${args.queries?.[0] ?? ""}` },
  web_fetch: { level: "L2", summarize: (args) => `\u6293\u53D6\u7F51\u9875 ${args.url ?? "?"}` },
  // 外部 MCP 资源读取同样出网（`packages/mcp/mcp-resources/src/tools.ts:52`）。
  read_mcp_resource: { level: "L2", summarize: (args) => `\u8BFB\u53D6\u5916\u90E8\u8D44\u6E90 ${args.uri ?? "?"}` },
  // 排程：现在这一次调用不改外部世界，但它留下了一个会在之后自己触发投递的东西
  // （`packages/schedule/tool-schedule/src/index.ts:446,505,531`）。
  schedule_create: { level: "L2", summarize: (args) => `\u5B89\u6392\u4E00\u6B21\u540E\u7EED\u63D0\u9192 ${args.prompt?.slice(0, 40) ?? ""}` },
  schedule_update: { level: "L2", summarize: () => "\u6539\u52A8\u4E00\u6761\u5DF2\u5B89\u6392\u7684\u63D0\u9192" },
  schedule_delete: { level: "L2", summarize: () => "\u53D6\u6D88\u4E00\u6761\u5DF2\u5B89\u6392\u7684\u63D0\u9192" },
  // 驱动别的 agent：它自己会调工具，而那些工具仍会逐个过这道闸，所以这里的风险是「放大」而不是「绕过」
  // （`tool-subagent/src/index.ts:380`、`tool-subagent-control/src/index.ts:29,75`）。
  subagent: { level: "L2", summarize: (args) => `\u6D3E\u751F\u5B50 agent \u6267\u884C\u300C${args.description ?? ""}\u300D` },
  subagent_fork: { level: "L2", summarize: () => "\u6D3E\u751F\u4E00\u4E2A\u5206\u53C9\u7684\u5B50 agent" },
  subagent_acp: { level: "L3", summarize: () => "\u628A\u4EFB\u52A1\u4EA4\u7ED9\u5916\u90E8 ACP agent \u6267\u884C" },
  send_message: { level: "L2", summarize: () => "\u7ED9\u53E6\u4E00\u4E2A agent \u53D1\u6307\u4EE4" },
  interrupt_agent: { level: "L2", summarize: () => "\u6253\u65AD\u53E6\u4E00\u4E2A agent \u6B63\u5728\u8DD1\u7684\u4E00\u8F6E" },
  // 多 agent 编排与杀作业是不可逆的放大（`tool-workflow/src/index.ts:329`、`tool-jobs/src/index.ts:372`）。
  workflow: { level: "L3", summarize: (args) => `\u7F16\u6392\u4E00\u6279\u5B50 agent\u300C${args.name ?? ""}\u300D` },
  job_kill: { level: "L3", summarize: () => "\u7EC8\u6B62\u4E00\u4E2A\u6B63\u5728\u8DD1\u7684\u540E\u53F0\u4F5C\u4E1A" },
  // 记忆层的自研工具（`office-memory/tools.ts`）。MU2 的争议原样记在这儿：
  // 判 L1 的理由是「写在 memoryRoot 内、幂等、对外不可见」；判 L2 的理由是「写进 `feedback`
  // 会改变以后所有回合的行为，影响面比一次写文件大」。第一版取 L1，但**不许悄悄降成 L0** ——
  // L0 意味着连台账都不留，而 §3.2 那套 `sourceSession` / `createdAt` 溯源全靠这次落盘。
  // 这一行也必须被字典断言钉住（F-H 的教训：字典不被断言时，全绿保护的不是产品会加载的那张表）。
  memory_write: { level: "L1", summarize: (args) => `\u8BB0\u4E00\u6761\u8BB0\u5FC6 ${args.title ?? args.body?.slice(0, 40) ?? ""}` },
  memory_archive: { level: "L1", summarize: (args) => `\u5F52\u6863\u4E00\u6761\u8BB0\u5FC6 ${args.path ?? ""}` },
  // §3.6④ 对第三把工具同样成立：照常登记、走同一条 pre-execute waterfall，没有后门，也不降 L0。
  // 判 L1 的效果就是 ME8 的机制本体：蒸馏进程的 `workspaceRoot` 即 `memoryRoot`（DM7），
  // L1 直接交棒 ⇒ 夜里零张审批卡 —— 若判 L2+，没人点卡的蒸馏会被闸拦下，夜间链路整条断掉。
  memory_distill: { level: "L1", summarize: () => "\u8DD1\u4E00\u6B21\u591C\u95F4\u8BB0\u5FC6\u84B8\u998F" }
};
function riskLevelOf(toolName, args, rules2) {
  const rule = rules2.get(toolName);
  if (rule === void 0) return "L4";
  return typeof rule.level === "function" ? rule.level(args) : rule.level;
}
function describeAction(toolName, args, rules2) {
  const rule = rules2.get(toolName);
  if (rule?.summarize !== void 0) return rule.summarize(args);
  if (rule !== void 0) return `\u6267\u884C ${toolName}`;
  if (toolName.startsWith("mcp__")) return `\u5916\u90E8 MCP \u5DE5\u5177 ${toolName}\uFF08\u672A\u767B\u8BB0\uFF0C\u6309\u6700\u9AD8\u98CE\u9669\u5904\u7406\uFF09`;
  return `\u672A\u8BC6\u522B\u7684\u5DE5\u5177 ${toolName}\uFF08\u9ED8\u8BA4\u6309\u6700\u9AD8\u98CE\u9669\u5904\u7406\uFF09`;
}
var defaultWindowMs = 9e4;
var defaultExpiresMs = {
  L2: 24 * 60 * 6e4,
  L3: 4 * 60 * 6e4,
  L4: 4 * 60 * 6e4
};
var askPrompts = {
  L2: { en: "This action is visible outside the workspace and needs your approval.", zh: "\u8FD9\u4E2A\u52A8\u4F5C\u4F1A\u5BF9\u5916\u53EF\u89C1\uFF0C\u9700\u8981\u4F60\u6279\u51C6\u3002" },
  L3: { en: "This action cannot be undone and needs your approval.", zh: "\u8FD9\u4E2A\u52A8\u4F5C\u4E0D\u53EF\u9006\uFF0C\u9700\u8981\u4F60\u6279\u51C6\u3002" },
  L4: { en: "This action affects the whole tenant and needs the owner to approve.", zh: "\u8FD9\u4E2A\u52A8\u4F5C\u5F71\u54CD\u6574\u4E2A\u79DF\u6237\uFF0C\u9700\u8981 owner \u6279\u51C6\u3002" }
};
function createRiskGate(options) {
  const rules2 = new Map(Object.entries(options.rules));
  const scope = options.gatedTools === void 0 || options.gatedTools.length === 0 ? void 0 : new Set(options.gatedTools);
  const now = options.now ?? (() => Date.now());
  const windowMs = options.windowMs ?? defaultWindowMs;
  const newRequestId = options.newRequestId ?? (() => randomUUID());
  return async function riskGate(exec, next) {
    if (scope !== void 0 && !scope.has(exec.name)) return await next();
    const level = riskLevelOf(exec.name, exec.arguments, rules2);
    if (level === "L0" || level === "L1") return await next();
    const agent = exec.agent;
    if (agent === void 0) {
      return { kind: "deny", reason: `tool "${exec.name}" is rated ${level} but the call has no agent to route approval through` };
    }
    const tenant = options.tenantOf(agent.session.id);
    if (tenant === void 0) return await next();
    const askedAt = now();
    const record = {
      requestId: newRequestId(),
      sessionId: agent.session.id,
      callId: exec.callId,
      rootCallId: exec.rootCallId,
      tenantId: tenant.tenantId,
      toolName: exec.name,
      riskLevel: level,
      actionSummary: describeAction(exec.name, exec.arguments, rules2),
      toolArgs: exec.arguments,
      // 台账只存一份文案：重启后凭它重建卡片时，产品语言就是中文；
      // 询问事件里仍然透传完整的 locale 表（D8）。
      displayReason: askPrompts[level].zh,
      status: "pending",
      askedAt,
      windowEndsAt: askedAt + windowMs,
      expiresAt: askedAt + (options.expiresMs?.[level] ?? defaultExpiresMs[level] ?? defaultExpiresMs.L2),
      decidedBy: null,
      decidedAt: null
    };
    try {
      await options.ledger.snapshot(record);
    } catch (error2) {
      const reason = error2 instanceof Error ? error2.message : String(error2);
      return { kind: "deny", reason: `tool "${exec.name}" is rated ${level} and its approval could not be recorded: ${reason}` };
    }
    return {
      kind: "ask",
      reason: `risk gate: ${level} tool "${exec.name}" requires human approval`,
      displayReason: askPrompts[level]
    };
  };
}
function installRiskGate(ctx, options) {
  return ctx.on("tools/pre-execute", createRiskGate(options));
}

// apps/fom-client/plugins/office-approval/tenant.ts
function createTenantResolver(deps) {
  const fixed = deps.fixed ?? "";
  if (fixed !== "") {
    return { current: () => ({ tenantId: fixed }), refresh: () => Promise.resolve() };
  }
  const now = deps.now ?? (() => Date.now());
  const ttlMs = deps.ttlMs ?? 1e4;
  let cached;
  let refreshedAt = Number.NEGATIVE_INFINITY;
  let inflight;
  const refresh = async () => {
    try {
      const token = await deps.readToken();
      cached = token === "" ? void 0 : deps.parseTenant(token);
      refreshedAt = now();
    } catch (error2) {
      deps.onError?.(error2);
    }
  };
  return {
    current() {
      if (now() - refreshedAt > ttlMs) {
        inflight ??= refresh().finally(() => {
          inflight = void 0;
        });
      }
      return cached === void 0 ? void 0 : { tenantId: cached };
    },
    async refresh() {
      inflight ??= refresh().finally(() => {
        inflight = void 0;
      });
      await inflight;
    }
  };
}

// apps/fom-client/plugins/office-login/session.ts
function b64urlToText(segment) {
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
  const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
function decodeJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length < 2) return null;
  try {
    return JSON.parse(b64urlToText(parts[1]));
  } catch {
    return null;
  }
}
function userFromToken(accessToken) {
  const payload = decodeJwtPayload(accessToken);
  if (payload === null) return null;
  const userId = typeof payload.sub === "string" ? payload.sub : "";
  const tenantId = typeof payload.tenant_id === "string" ? payload.tenant_id : "";
  if (userId === "" && tenantId === "") return null;
  return {
    userId,
    tenantId,
    ...typeof payload.email === "string" ? { email: payload.email } : {},
    ...typeof payload.role === "string" ? { role: payload.role } : {}
  };
}

// apps/fom-client/plugins/office-approval/responder.ts
var PendingApprovalWindows = class {
  #handlers = /* @__PURE__ */ new Map();
  /** 登记一个正在等的窗口，返回撤销句柄（窗口结束时必须调用，否则决策会交给一个已经不存在的等待方）。 */
  register(requestId, handler) {
    this.#handlers.set(requestId, handler);
    return () => {
      if (this.#handlers.get(requestId) === handler) this.#handlers.delete(requestId);
    };
  }
  /** 有人在等就交付并返回 true；没人等返回 false —— 调用方据此决定要不要唤醒会话。 */
  settle(requestId, click) {
    const handler = this.#handlers.get(requestId);
    if (handler === void 0) return false;
    handler(click);
    return true;
  }
};
function outcomeOf(record) {
  if (record === void 0) return "cancelled";
  switch (record.status) {
    case "approved":
      return "allowed-once";
    case "rejected":
      return "rejected";
    default:
      return "cancelled";
  }
}
function createApprovalResponder(options) {
  const now = options.now ?? (() => Date.now());
  const { ledger, channel } = options;
  return async function approvalResponder(req, next) {
    if (req.callId === void 0) return await next();
    const record = ledger.findByCall(req.callId);
    if (record === void 0) return await next();
    if (record.status === "approved" || record.status === "consumed") return "allowed-once";
    if (record.status === "rejected") return "rejected";
    const digest = argsDigest(record.toolArgs);
    const granted = await ledger.consumeGrant(record.toolName, digest, now());
    if (granted !== void 0) {
      await ledger.transition(record.requestId, { from: ["pending"], to: "consumed" });
      return "allowed-once";
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("window-expired"), Math.max(0, record.windowEndsAt - now()));
    const upstream = req.signal;
    const onUpstreamAbort = () => controller.abort(upstream?.reason);
    upstream?.addEventListener("abort", onUpstreamAbort, { once: true });
    const inbound = Promise.withResolvers();
    let settledExternally = false;
    const release = options.windows?.register(record.requestId, (click) => {
      settledExternally = true;
      inbound.resolve(click);
    });
    try {
      let card;
      try {
        card = await channel.send(record, controller.signal);
      } catch {
        if (!settledExternally) {
          const outcome = await next();
          if (outcome === "allowed-once") {
            await ledger.transition(record.requestId, { from: ["pending"], to: "consumed" }).catch((error2) => options.onHandoffError?.(record.requestId, error2));
          }
          return outcome;
        }
      }
      const click = card === void 0 ? await inbound.promise : await Promise.race([card.waitForClick(controller.signal), inbound.promise]);
      if (settledExternally) controller.abort("settled-externally");
      if (click === void 0) {
        const expired = controller.signal.reason === "window-expired";
        await ledger.transition(record.requestId, { from: ["pending"], to: expired ? "expired" : "recalled" });
        if (card !== void 0) {
          const current = ledger.get(record.requestId);
          if (current !== void 0 && isDecidable(current, now())) {
            await channel.defer(card, expired ? "\u540C\u6B65\u7A97\u53E3\u5185\u6CA1\u4EBA\u5E94\u7B54\uFF0C\u5DF2\u8F6C\u540E\u53F0\u7B49\u5F85\u5BA1\u6279" : "\u672C\u6B21\u8BE2\u95EE\u5DF2\u4F5C\u5E9F\uFF0C\u8FD9\u6761\u5BA1\u6279\u4ECD\u53EF\u6279\u51C6");
          } else {
            await channel.recall(card, "\u672C\u6B21\u8BE2\u95EE\u5DF2\u4F5C\u5E9F");
          }
        }
        return "cancelled";
      }
      const decisionAt = now();
      const to = click.decision === "approve" ? "approved" : "rejected";
      const won = await ledger.transition(record.requestId, {
        from: ["pending"],
        to,
        set: { decidedBy: click.openId, decidedAt: decisionAt }
      });
      if (!won) return outcomeOf(ledger.get(record.requestId));
      if (card !== void 0) {
        await channel.update(card, click.decision === "approve" ? `\u5DF2\u7531 ${click.openId} \u6279\u51C6` : `\u5DF2\u7531 ${click.openId} \u62D2\u7EDD`);
      }
      return click.decision === "approve" ? "allowed-once" : "rejected";
    } finally {
      clearTimeout(timer);
      upstream?.removeEventListener("abort", onUpstreamAbort);
      release?.();
    }
  };
}
function installApprovalResponder(ctx, options) {
  return ctx.on("approval/request", createApprovalResponder(options), { prepend: true });
}

// apps/fom-client/plugins/office-approval/callback-route.ts
import { createHash as createHash2, randomUUID as randomUUID2, timingSafeEqual } from "node:crypto";
import { z as z2 } from "zod";
var defaultToleranceMs = 5 * 6e4;
var defaultMaxBodyBytes = 64 * 1024;
function feishuCardSignature(parts) {
  return createHash2("sha1").update(`${parts.timestamp}${parts.nonce}${parts.token}${parts.body}`, "utf8").digest("hex");
}
function constantTimeEquals(expected, provided) {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.byteLength !== b.byteLength) return false;
  return timingSafeEqual(a, b);
}
var cardValueSchema = z2.object({
  requestId: z2.string().min(1),
  decision: z2.enum(["approve", "reject"])
});
var cardCallbackSchema = z2.object({
  event: z2.object({
    operator: z2.object({ open_id: z2.string().min(1) }),
    action: z2.object({ value: z2.unknown() })
  })
});
var challengeSchema = z2.object({
  type: z2.literal("url_verification"),
  challenge: z2.string().min(1),
  token: z2.string().optional()
});
function createApprovalCallbackHandler(options) {
  const now = options.now ?? (() => Date.now());
  const toleranceMs = options.toleranceMs ?? defaultToleranceMs;
  const newDenialId = options.newDenialId ?? (() => randomUUID2());
  const newGrantId = options.newGrantId ?? (() => randomUUID2());
  const { ledger } = options;
  function authenticate(input) {
    const sentAt = Number(input.timestamp);
    if (!Number.isFinite(sentAt)) return "bad-timestamp";
    if (Math.abs(now() - sentAt) > toleranceMs) return "bad-timestamp";
    const expected = feishuCardSignature({
      timestamp: input.timestamp,
      nonce: input.nonce,
      token: options.verificationToken(),
      body: input.rawBody
    });
    return constantTimeEquals(expected, input.signature) ? void 0 : "signature-mismatch";
  }
  async function audit(denial) {
    try {
      await ledger.recordDenial(denial);
    } catch (error2) {
      options.onAuditError?.(error2, denial);
    }
  }
  function settle(event) {
    try {
      void Promise.resolve(options.onSettled?.(event)).catch((error2) => {
        options.onSettledError?.(error2, event);
      });
    } catch (error2) {
      options.onSettledError?.(error2, event);
    }
  }
  function recordNow(requestId) {
    const fresh = ledger.get(requestId);
    if (fresh === void 0) throw new Error(`approval callback: record ${requestId} vanished between write and notify`);
    return fresh;
  }
  return async function handle(input) {
    if (options.verificationToken() === "") {
      return { status: 401, body: { code: "verification-token-unset" } };
    }
    const signed = input.timestamp !== void 0 && input.nonce !== void 0 && input.signature !== void 0;
    if (signed) {
      const failure = authenticate({ rawBody: input.rawBody, timestamp: input.timestamp, nonce: input.nonce, signature: input.signature });
      if (failure !== void 0) return { status: 401, body: { code: failure } };
    }
    let parsed;
    try {
      parsed = JSON.parse(input.rawBody);
    } catch {
      return { status: signed ? 400 : 401, body: { code: signed ? "malformed-json" : "missing-signature" } };
    }
    const challenge = challengeSchema.safeParse(parsed);
    if (challenge.success) {
      if (signed) return { status: 200, body: { challenge: challenge.data.challenge } };
      return constantTimeEquals(options.verificationToken(), challenge.data.token ?? "") ? { status: 200, body: { challenge: challenge.data.challenge } } : { status: 401, body: { code: "missing-signature" } };
    }
    if (!signed) return { status: 401, body: { code: "missing-signature" } };
    const envelope = cardCallbackSchema.safeParse(parsed);
    if (!envelope.success) return { status: 200, body: error("\u8FD9\u4E2A\u6309\u94AE\u7684\u6570\u636E\u4E0D\u5B8C\u6574\uFF0C\u8BF7\u91CD\u65B0\u53D1\u8D77\u4E00\u6B21\u52A8\u4F5C\u3002") };
    const value = cardValueSchema.safeParse(envelope.data.event.action.value);
    if (!value.success) return { status: 200, body: error("\u8FD9\u4E2A\u6309\u94AE\u6CA1\u6709\u5E26\u56DE\u5BA1\u6279\u7F16\u53F7\uFF0C\u65E0\u6CD5\u6838\u5BF9\u3002") };
    const openId = envelope.data.event.operator.open_id;
    const record = ledger.get(value.data.requestId);
    if (record === void 0) return { status: 200, body: error("\u8FD9\u6761\u5BA1\u6279\u5DF2\u7ECF\u4E0D\u5B58\u5728\u4E86\u3002") };
    const at = now();
    if (at > record.expiresAt) {
      return { status: 200, body: error("\u8FD9\u6761\u5BA1\u6279\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u8BA9\u53D1\u8D77\u4EBA\u91CD\u65B0\u53D1\u8D77\u3002") };
    }
    if (record.tenantId !== options.tenantId) {
      await audit({ denialId: newDenialId(), requestId: record.requestId, tenantId: record.tenantId, openId, at, reason: "tenant-mismatch" });
      return { status: 200, body: error("\u8FD9\u6761\u5BA1\u6279\u4E0D\u5C5E\u4E8E\u5F53\u524D\u63A5\u5165\u7684\u5E94\u7528\u3002") };
    }
    const approvers = options.approversOf(record);
    if (approvers === void 0) {
      await audit({ denialId: newDenialId(), requestId: record.requestId, tenantId: record.tenantId, openId, at, reason: "approvers-unresolvable" });
      return { status: 200, body: error("\u6CA1\u67E5\u5230\u8FD9\u6761\u5BA1\u6279\u7684\u5BA1\u6279\u4EBA\u540D\u5355\uFF0C\u5148\u4E0D\u5904\u7406\u3002") };
    }
    if (!approvers.includes(openId)) {
      await audit({ denialId: newDenialId(), requestId: record.requestId, tenantId: record.tenantId, openId, at, reason: "not-approver" });
      return { status: 200, body: error("\u8FD9\u6761\u5BA1\u6279\u9700\u8981\u7531\u5BA1\u6279\u4EBA\u5904\u7406\uFF0C\u4F60\u4E0D\u662F\u5176\u4E2D\u4E4B\u4E00\u3002") };
    }
    if (value.data.decision === "reject") {
      if (options.handToWindow?.(record.requestId, { decision: "reject", openId })) {
        return { status: 200, body: ok("\u5DF2\u62D2\u7EDD\uFF0C\u6211\u4F1A\u628A\u8FD9\u4E2A\u7ED3\u679C\u544A\u8BC9\u53D1\u8D77\u4EBA\u3002") };
      }
      const won = await ledger.transition(record.requestId, {
        from: ["pending", "expired", "recalled"],
        to: "rejected",
        set: { decidedBy: openId, decidedAt: at }
      });
      if (!won) return { status: 200, body: decided() };
      settle({ record: recordNow(record.requestId), decision: "reject" });
      return { status: 200, body: ok("\u5DF2\u62D2\u7EDD\uFF0C\u6211\u4F1A\u628A\u8FD9\u4E2A\u7ED3\u679C\u544A\u8BC9\u53D1\u8D77\u4EBA\u3002") };
    }
    if (options.handToWindow?.(record.requestId, { decision: "approve", openId })) {
      return { status: 200, body: ok("\u5DF2\u6279\u51C6\uFF0C\u8FD9\u6B21\u8C03\u7528\u5DF2\u7ECF\u5728\u5F53\u524D\u56DE\u5408\u6267\u884C\u3002") };
    }
    const digest = argsDigest(record.toolArgs);
    const grantId = newGrantId();
    let approved;
    try {
      approved = await ledger.approve(record.requestId, {
        decidedBy: openId,
        now: at,
        grant: { grantId, toolName: record.toolName, argsDigest: digest, grantExpiresAt: record.expiresAt }
      });
    } catch {
      return { status: 200, body: error("\u6279\u51C6\u6CA1\u80FD\u843D\u8D26\uFF0C\u8BF7\u7A0D\u540E\u518D\u70B9\u4E00\u6B21\u3002") };
    }
    if (!approved.won) return { status: 200, body: decided() };
    settle({ record: recordNow(record.requestId), decision: "approve", grantId });
    return { status: 200, body: ok("\u5DF2\u6279\u51C6\uFF0C\u8FD9\u4E2A\u52A8\u4F5C\u4F1A\u5728\u4E0B\u4E00\u4E2A\u56DE\u5408\u81EA\u52A8\u6267\u884C\u4E00\u6B21\u3002") };
  };
}
function error(content) {
  return { toast: { type: "error", content } };
}
function ok(content) {
  return { toast: { type: "success", content } };
}
function decided() {
  return { toast: { type: "info", content: "\u8FD9\u6761\u5BA1\u6279\u5DF2\u7ECF\u5904\u7406\u8FC7\u4E86\uFF0C\u4E0D\u518D\u91CD\u590D\u6267\u884C\u3002" } };
}
async function readRawBody(request, maxBytes = defaultMaxBodyBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
    size += buffer.byteLength;
    if (size > maxBytes) return void 0;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
function installApprovalCallbackRoute(ctx, options) {
  const path = options.path ?? "/office/approval/callback";
  const maxBodyBytes = options.maxBodyBytes ?? defaultMaxBodyBytes;
  const handle = createApprovalCallbackHandler(options);
  ctx.effect(() => {
    const server = ctx.get("webServer");
    if (server === void 0) return () => {
    };
    return server.register({
      kind: "exact",
      path,
      handler: async (request, response) => {
        if (request.method !== "POST") {
          response.writeHead(405, { "content-type": "application/json" });
          response.end(JSON.stringify({ code: "method-not-allowed" }));
          return;
        }
        const rawBody = await readRawBody(request, maxBodyBytes);
        if (rawBody === void 0) {
          response.writeHead(413, { "content-type": "application/json" });
          response.end(JSON.stringify({ code: "body-too-large" }));
          return;
        }
        const result = await handle({
          rawBody,
          timestamp: headerOf(request, "x-lark-request-timestamp"),
          nonce: headerOf(request, "x-lark-request-nonce"),
          signature: headerOf(request, "x-lark-signature")
        });
        response.writeHead(result.status, { "content-type": "application/json" });
        response.end(JSON.stringify(result.body));
      }
    });
  }, "office-approval: \u5BA1\u6279\u56DE\u8C03\u8DEF\u7531");
}
function headerOf(request, name) {
  const value = request.headers[name];
  return typeof value === "string" ? value : void 0;
}

// apps/fom-client/plugins/office-approval/recovery.ts
import { createUserMessage } from "@deepseek-ai/dsh-llm";
function decisionText(record, decidedBy) {
  const payload = JSON.stringify({ name: record.toolName, arguments: record.toolArgs });
  return [
    `[\u5BA1\u6279\u51B3\u7B56] \u7F16\u53F7 ${record.requestId}\uFF1A${record.actionSummary}`,
    `\u7531 ${decidedBy} ${record.status === "rejected" ? "\u62D2\u7EDD" : "\u6279\u51C6"}\u3002\u8FD9\u662F\u5BF9\u4F60\u4E0A\u4E00\u6B21\u8BF7\u6C42\u7684\u7B54\u590D\uFF0C\u4E0D\u662F\u65B0\u7684\u7528\u6237\u6307\u4EE4\u3002`,
    record.status === "rejected" ? "\u4E0D\u8981\u518D\u6B21\u5C1D\u8BD5\u8FD9\u4E2A\u52A8\u4F5C\uFF0C\u4E5F\u4E0D\u8981\u6362\u4E00\u79CD\u5199\u6CD5\u7ED5\u8FC7\u5BA1\u6279\uFF1B\u8BF7\u628A\u7ED3\u679C\u544A\u8BC9\u7528\u6237\u5E76\u8BE2\u95EE\u4E0B\u4E00\u6B65\u3002" : "\u8BF7\u539F\u6837\u91CD\u653E\u4E0B\u9762\u8FD9\u6B21\u5DE5\u5177\u8C03\u7528\uFF0C\u53C2\u6570\u4E00\u5B57\u4E0D\u6539\u3002\u8FD9\u6B21\u6279\u51C6\u53EA\u5BF9\u8FD9\u7EC4\u53C2\u6570\u6709\u6548\u4E00\u6B21\uFF0C\u6539\u52A8\u53C2\u6570\u4F1A\u91CD\u65B0\u89E6\u53D1\u5BA1\u6279\u3002",
    `tool_call_json: ${payload}`
  ].join("\n");
}
function createApprovalRecovery(options) {
  const { ledger, windows } = options;
  async function compensate(event) {
    if (event.decision !== "approve") return;
    let transitioned = false;
    try {
      transitioned = await ledger.transition(event.record.requestId, { from: ["approved"], to: "expired" });
    } catch (error2) {
      options.onFailure?.("compensation-incomplete", event, error2);
      return;
    }
    if (!transitioned) return;
    if (event.grantId === void 0) return;
    try {
      await ledger.revokeGrant(event.grantId);
    } catch (error2) {
      options.onFailure?.("compensation-incomplete", event, error2);
    }
  }
  return async function recover(event) {
    const { record } = event;
    const decidedBy = record.decidedBy ?? "unknown";
    if (windows.settle(record.requestId, { decision: event.decision, openId: decidedBy })) {
      if (event.grantId !== void 0) await ledger.revokeGrant(event.grantId);
      return;
    }
    const message = createUserMessage({
      content: [{ type: "text", text: decisionText(record, decidedBy) }],
      source: { kind: "approval-decision" }
    });
    let agent;
    try {
      agent = await options.resolveAgent(record.sessionId);
    } catch (error2) {
      await compensate(event);
      options.onFailure?.("agent-unresolvable", event, error2);
      return;
    }
    if (agent === void 0) {
      await compensate(event);
      options.onFailure?.("agent-unresolvable", event);
      return;
    }
    agent.followup(message);
    let flushed = false;
    try {
      flushed = await options.flush(agent.session);
    } catch (error2) {
      options.onFailure?.("persistence-unacknowledged", event, error2);
      return;
    }
    if (!flushed) options.onFailure?.("persistence-unacknowledged", event);
  };
}

// apps/fom-client/plugins/office-approval/sweeper.ts
import { SessionId } from "@deepseek-ai/dsh-session";
import { ScheduleId } from "@deepseek-ai/dsh-schedule";
var defaultRemindAfterMs = 30 * 6e4;
function sweepIdOf(requestId, kind) {
  return `${requestId}_${kind}`;
}
function alarmTitle(kind, record) {
  const label = kind === "remind" ? "\u5BA1\u6279\u50AC\u529E" : "\u5BA1\u6279\u8FC7\u671F";
  const summary = record.actionSummary.length > 80 ? `${record.actionSummary.slice(0, 79)}\u2026` : record.actionSummary;
  const title = `${label} \xB7 ${summary}`;
  return title.length <= 120 ? title : `${title.slice(0, 119)}\u2026`;
}
function alarmPrompt(kind, record) {
  const line = `\u7F16\u53F7 ${record.requestId}\uFF08${record.actionSummary}\uFF09`;
  return kind === "remind" ? `[\u5E73\u53F0\u50AC\u529E] ${line} \u4ECD\u5728\u7B49\u5F85\u6279\u51C6\uFF0C\u5E73\u53F0\u5DF2\u91CD\u65B0\u63D0\u9192\u5BA1\u6279\u4EBA\u3002\u8FD9\u4E0D\u662F\u65B0\u7684\u7528\u6237\u6307\u4EE4\uFF1A\u4E0D\u8981\u91CD\u590D\u53D1\u8D77\u540C\u4E00\u4E2A\u52A8\u4F5C\uFF0C\u4E5F\u4E0D\u8981\u4EE3\u66FF\u5BA1\u6279\u4EBA\u6279\u51C6\u3002` : `[\u5E73\u53F0\u901A\u77E5] ${line} \u7684\u8BF7\u6C42\u56E0\u672A\u83B7\u6279\u51C6\u5DF2\u4F5C\u5E9F\u3002\u4E0D\u8981\u91CD\u590D\u53D1\u8D77\uFF1B\u5982\u9700\u7EE7\u7EED\uFF0C\u8BF7\u5411\u7528\u6237\u8BF4\u660E\u5E76\u7B49\u5F85\u6307\u793A\u3002`;
}
function createApprovalSweeper(options) {
  const now = options.now ?? (() => Date.now());
  const remindAfterMs = options.remindAfterMs ?? defaultRemindAfterMs;
  const { ledger, alarms, targets } = options;
  function report(row, stage, error2) {
    options.onFailure?.({ ...row, stage, error: error2 });
  }
  async function armKind(record, kind, at) {
    const sweepId = sweepIdOf(record.requestId, kind);
    if (ledger.sweep(sweepId) !== void 0) return;
    const created = await ledger.armSweep({
      sweepId,
      requestId: record.requestId,
      kind,
      at,
      alarmId: null,
      status: "armed",
      armedAt: now(),
      firedAt: null
    });
    if (!created) return;
    if (at <= now()) {
      await fire(sweepId);
      return;
    }
    try {
      const alarmId = await alarms.arm({
        sessionId: record.sessionId,
        requestId: record.requestId,
        kind,
        at,
        title: alarmTitle(kind, record),
        prompt: alarmPrompt(kind, record)
      });
      await ledger.attachAlarm(sweepId, alarmId);
    } catch (error2) {
      await ledger.forgetSweep(sweepId).catch(() => {
      });
      report({ sweepId, requestId: record.requestId, kind }, "arm", error2);
    }
  }
  async function arm(record) {
    if (!awaitsDecision(record, now())) return;
    await armKind(record, "remind", record.askedAt + remindAfterMs);
    await armKind(record, "expire", record.expiresAt);
  }
  async function settle(requestId, keepExpire = false) {
    const record = ledger.get(requestId);
    for (const row of ledger.sweepsOf(requestId)) {
      if (row.status !== "armed") continue;
      if (keepExpire && row.kind === "expire") continue;
      const alarmId = await ledger.cancelSweep(row.sweepId);
      if (alarmId === void 0 || record === void 0) continue;
      try {
        await alarms.cancel(alarmId, record.sessionId);
      } catch (error2) {
        report(row, "cancel", error2);
      }
    }
  }
  async function fire(sweepId) {
    const row = ledger.sweep(sweepId);
    if (row === void 0) return "unknown";
    const record = ledger.get(row.requestId);
    if (record === void 0) return "unknown";
    if (row.status !== "armed") return "skipped";
    const at = now();
    const actionable = row.kind === "remind" ? isDecidable(record, at) : record.status === "approved" ? ledger.hasOutstandingGrant(record.requestId) : awaitsExpiry(record);
    if (!actionable) {
      await ledger.cancelSweep(sweepId);
      return "skipped";
    }
    if (!await ledger.claimSweep(sweepId, now())) return "skipped";
    if (row.kind === "remind") {
      try {
        await targets.remind(record);
      } catch (error2) {
        report(row, "remind", error2);
        return "skipped";
      }
      return "reminded";
    }
    try {
      const won = await ledger.transition(record.requestId, { from: ["pending", "approved"], to: "expired" });
      const fresh = ledger.get(record.requestId) ?? record;
      if (!won && fresh.status !== "expired") return "skipped";
      await ledger.revokeGrantsFor(record.requestId);
      await targets.expire(fresh);
    } catch (error2) {
      report(row, "expire", error2);
      return "skipped";
    }
    return "expired";
  }
  async function scanOpen() {
    const open = ledger.openRequests(now());
    for (const record of open) {
      if (record.status === "approved") {
        if (ledger.hasOutstandingGrant(record.requestId)) await armKind(record, "expire", record.expiresAt);
      } else await arm(record);
    }
    return open.length;
  }
  function armedAlarmIds() {
    const out = /* @__PURE__ */ new Map();
    for (const row of ledger.armedSweeps()) {
      if (row.alarmId !== null) out.set(row.alarmId, row.sweepId);
    }
    return out;
  }
  return { arm, settle, fire, scanOpen, armedAlarmIds };
}
function createScheduleAlarms(ctx) {
  return {
    async arm(input) {
      const record = await ctx.schedule.create(SessionId(input.sessionId), {
        title: input.title,
        prompt: input.prompt,
        at: new Date(input.at).toISOString()
      });
      return String(record.id);
    },
    /**
     * `schedule.delete` 对已经不存在的 job 返回 `{deleted:false, code:'schedule_not_found'}`
     * 而不是抛 —— 一次没删掉**没有**留下任何正确性问题：登记行此时已是 `cancelled`，
     * 残留 job 到点只会拿到 `skipped`。所以这里不把"没删掉"当失败上报。
     */
    async cancel(alarmId, sessionId) {
      await ctx.schedule.delete({ id: ScheduleId(alarmId), sessionId: SessionId(sessionId) });
    },
    async drain(sweeper) {
      const armed = sweeper.armedAlarmIds();
      if (armed.size === 0) return 0;
      const entries = await ctx.schedule.catalog();
      let handled = 0;
      for (const entry of entries) {
        if (entry.lastDelivery === void 0) continue;
        const sweepId = armed.get(String(entry.id));
        if (sweepId === void 0) continue;
        handled += 1;
        await sweeper.fire(sweepId);
      }
      return handled;
    }
  };
}
function installApprovalSweeper(ctx, options) {
  const alarms = createScheduleAlarms(ctx);
  const sweeper = createApprovalSweeper({ ...options, alarms });
  const at = options.now ?? (() => Date.now());
  const releaseLedger = options.ledger.onChanged((record) => {
    switch (record.status) {
      case "pending":
        return void sweeper.arm(record);
      // 批准了：催办就此停止。作废留不留取决于**这条批准有没有落下批件**（`ledger.approve`
      // 让通知排在批件落账之后，所以这里读得到）：有批件 = 可能永远等不到重放，§3.5 的安全阀
      // 必须留着到点收回它；没批件 = 同步窗口内已经执行完，留着只是白挂一条幽灵自动化，
      // 且到点会误作废这条已完成的批准（#38）。
      case "approved":
        return void sweeper.settle(record.requestId, options.ledger.hasOutstandingGrant(record.requestId));
      default:
        if (isDecidable(record, at())) return;
        return void sweeper.settle(record.requestId);
    }
  });
  const releaseSchedule = ctx.on("schedule/changed", () => {
    void alarms.drain(sweeper).catch((error2) => ctx.logger.warn(`approval sweeper: drain failed: ${String(error2)}`));
  });
  void sweeper.scanOpen();
  return () => {
    releaseLedger();
    releaseSchedule();
  };
}

// apps/fom-client/plugins/office-approval/feishu-channel.ts
import { createHash as createHash3 } from "node:crypto";
var FeishuApiError = class extends Error {
  constructor(code, message, path) {
    super(`feishu ${code} at ${path}: ${message}`);
    this.code = code;
    this.path = path;
    this.name = "FeishuApiError";
  }
};
var alreadyGoneCodes = /* @__PURE__ */ new Set([230008, 230011, 230110]);
var tokenInvalidCodes = /* @__PURE__ */ new Set([99991651, 99991663]);
function plain(content) {
  return { tag: "plain_text", content };
}
function md(content) {
  return { tag: "lark_md", content };
}
function cardValue(requestId, decision) {
  return { requestId, decision };
}
function needsSecondConfirm(level) {
  return level === "L3" || level === "L4";
}
function secondConfirmDialog(level) {
  return {
    title: plain(`\u786E\u8BA4${level}\u52A8\u4F5C\uFF1F`),
    text: plain(level === "L4" ? "\u8FD9\u4E2A\u52A8\u4F5C\u5F71\u54CD\u6574\u4E2A\u79DF\u6237\uFF0C\u786E\u8BA4\u540E\u7ACB\u523B\u6267\u884C\u4E14\u4E0D\u518D\u8BE2\u95EE\u3002" : "\u8FD9\u4E2A\u52A8\u4F5C\u4E0D\u53EF\u9006\uFF0C\u786E\u8BA4\u540E\u7ACB\u523B\u6267\u884C\u4E14\u4E0D\u518D\u8BE2\u95EE\u3002")
  };
}
function buildApprovalCard(record, state, policy) {
  const digest = argsDigest(record.toolArgs);
  const settled = state.kind === "decided" || state.kind === "expired" || state.kind === "superseded";
  const elements = [
    { tag: "div", text: md(record.displayReason) },
    {
      tag: "div",
      text: md([
        `**\u52A8\u4F5C**\uFF1A${record.actionSummary}`,
        `**\u98CE\u9669\u7EA7**\uFF1A${record.riskLevel}\u3000**\u7F16\u53F7**\uFF1A${record.requestId}`,
        `**\u53C2\u6570\u6307\u7EB9**\uFF1A${digest.slice(0, 12)}\uFF08\u6279\u51C6\u540E\u6309\u8FD9\u4EFD\u53C2\u6570\u539F\u6837\u91CD\u653E\uFF09`
      ].join("\n"))
    }
  ];
  if (needsSecondConfirm(record.riskLevel)) {
    const repeat = policy.repeatAsks(record);
    elements.push({
      tag: "div",
      text: md([
        "\u8FD9\u4E2A\u52A8\u4F5C**\u4E0D\u53EF\u9006**\u6216**\u5F71\u54CD\u6574\u4E2A\u79DF\u6237**\u3002\u5728\u653E\u5BBD\u6743\u9650\u4E4B\u524D\uFF0C\u5148\u8003\u8651\uFF1A",
        "\u2460 \u6539\u7528\u5DE5\u4F5C\u533A\u5185\u7684\u8DEF\u5F84\uFF1B\u2461 \u8BA9 Agent \u6362\u4E00\u79CD\u505A\u6CD5\u3002",
        `\u653E\u5BBD\u6743\u9650\u4F1A\u7ED5\u8FC7\u6C99\u7BB1\u4FDD\u62A4\uFF0C\u4E14\u672C\u4F1A\u8BDD\u5DF2\u7D2F\u8BA1\u653E\u5BBD ${String(policy.relaxationCount(record))} \u6B21\u3002`,
        // U9：同一个动作被反复询问时，让第二张卡自己说出「第 N 次」，把重复交到审批人眼前。
        ...repeat > 1 ? [`\u26A0\uFE0F \u8FD9\u5DF2\u662F\u672C\u4F1A\u8BDD\u7B2C ${String(repeat)} \u6B21\u4E3A**\u540C\u4E00\u4E2A\u52A8\u4F5C**\u8BF7\u6C42\u653E\u5BBD\u6743\u9650\uFF08\u540C\u4E00\u4E2A Agent \u5728\u8D85\u7A97\u540E\u91CD\u8BD5\u7684\u53EF\u80FD\u6027\u5927\uFF09\u2014\u2014\u5148\u786E\u8BA4\u8FD9\u6B21\u662F\u5426\u771F\u7684\u8FD8\u8981\u505A\u3002`] : []
      ].join("\n"))
    });
  }
  if (state.kind === "reminded") elements.push({ tag: "div", text: md("\u8FD9\u662F**\u552F\u4E00\u4E00\u6B21**\u50AC\u529E\uFF1A\u4ECD\u672A\u83B7\u5F97\u6279\u51C6\u3002") });
  if (state.kind === "deferred") {
    elements.push({ tag: "div", text: md(`${state.text}
\u8FD9\u6761\u5BA1\u6279**\u4ECD\u7136\u53EF\u4EE5\u6279\u51C6**\uFF0C\u6279\u51C6\u4F1A\u5728\u4E0B\u4E00\u4E2A\u56DE\u5408\u6267\u884C\u4E00\u6B21\u3002`) });
  }
  if (state.kind === "decided") elements.push({ tag: "div", text: md(state.text) });
  if (state.kind === "expired") elements.push({ tag: "div", text: md("\u8FD9\u6761\u5BA1\u6279\u5DF2\u8FC7\u671F\u4F5C\u5E9F\uFF0C\u4E0D\u518D\u53D7\u7406\u3002") });
  if (state.kind === "superseded") elements.push({ tag: "div", text: md("\u8FD9\u5F20\u5361\u5DF2\u88AB\u65B0\u7684\u63D0\u9192\u53D6\u4EE3\uFF0C\u8BF7\u5230\u6700\u65B0\u5361\u7247\u4E0A\u5904\u7406\u3002") });
  const secondConfirm = needsSecondConfirm(record.riskLevel) && !settled;
  elements.push({
    tag: "button",
    text: plain(secondConfirm ? "\u786E\u8BA4\u6279\u51C6\uFF08\u4E0D\u53EF\u9006\uFF09" : "\u6279\u51C6"),
    type: "primary",
    // 置灰是官方的 `disabled` 字段：终态之后按钮必须点不动，否则同一张卡诱导审批人反复点
    //（§3.6 的点击洪峰）。
    disabled: settled,
    // L3/L4 的批准按钮先弹确认框（§5 的「卡片二次确认」）。回传值与一级点击完全相同 ——
    // 二次确认是 IM 侧的人因防线，服务端不认任何"已确认"标记，见 `secondConfirmDialog`。
    ...secondConfirm ? { confirm: secondConfirmDialog(record.riskLevel) } : {},
    behaviors: [{ type: "callback", value: cardValue(record.requestId, "approve") }]
  }, {
    tag: "button",
    text: plain("\u62D2\u7EDD"),
    type: "danger",
    disabled: settled,
    behaviors: [{ type: "callback", value: cardValue(record.requestId, "reject") }]
  });
  const textTag = (color, text) => ({ tag: "text_tag", text: plain(text), color });
  const tag = state.kind === "decided" ? textTag("green", "\u5DF2\u51B3\u7B56") : state.kind === "expired" ? textTag("grey", "\u5DF2\u8FC7\u671F") : state.kind === "superseded" ? textTag("grey", "\u5DF2\u53D6\u4EE3") : state.kind === "reminded" ? textTag("orange", "\u5F85\u6279\u51C6 \xB7 \u5DF2\u50AC\u529E") : state.kind === "deferred" ? textTag("blue", "\u5F85\u6279\u51C6 \xB7 \u8F6C\u540E\u53F0") : textTag("blue", "\u5F85\u6279\u51C6");
  return {
    schema: "2.0",
    config: { update_multi: true },
    header: { title: plain(`\u5BA1\u6279\u8BF7\u6C42 \xB7 ${record.toolName}`), text_tag_list: [tag] },
    body: { elements }
  };
}
function createTenantTokenSource(transport, appId, appSecret, options = {}) {
  const now = options.now ?? (() => Date.now());
  const skewMs = options.skewMs ?? 6e4;
  let cached;
  let inflight;
  async function issue() {
    const path = "/open-apis/auth/v3/tenant_access_token/internal";
    const reply = await transport({ method: "POST", path, body: { app_id: appId, app_secret: appSecret } });
    if (reply.code !== 0 || reply.tenant_access_token === void 0) {
      throw new FeishuApiError(reply.code, reply.msg ?? "tenant_access_token missing", path);
    }
    return { value: reply.tenant_access_token, expiresAt: now() + Math.max(0, (reply.expire ?? 7200) * 1e3 - skewMs) };
  }
  return {
    async token() {
      if (cached !== void 0 && cached.expiresAt > now()) return cached.value;
      inflight ??= issue().then((next) => {
        cached = next;
        return next;
      }).finally(() => {
        inflight = void 0;
      });
      return (await inflight).value;
    },
    invalidate() {
      cached = void 0;
    }
  };
}
function cardUuid(requestId, attempt, recipient) {
  return `oa-${attempt}-${uuidDigest(requestId, recipient)}`;
}
function noticeUuid(requestId, recipient) {
  return `oa-notice-${uuidDigest(requestId, recipient)}`;
}
function uuidDigest(requestId, recipient) {
  return createHash3("sha1").update(`${requestId}\0${recipient}`, "utf8").digest("hex").slice(0, 24);
}
function createFeishuApprovalChannel(options) {
  const now = options.now ?? (() => Date.now());
  const { transport, tokens, ledger } = options;
  async function call(method, path, body, query) {
    const send = async () => await transport({ method, path, query, body, token: await tokens.token() });
    let reply = await send();
    if (tokenInvalidCodes.has(reply.code)) {
      tokens.invalidate();
      reply = await send();
    }
    if (reply.code !== 0) throw new FeishuApiError(reply.code, reply.msg ?? "feishu call failed", path);
    return reply.data;
  }
  async function sendCard(record, state, attempt) {
    const recipients = options.recipientsOf(record);
    if (recipients === void 0 || recipients.length === 0) {
      throw new Error(`approval channel: no recipient resolved for ${record.requestId}`);
    }
    const content = JSON.stringify(buildApprovalCard(record, state, options.policy));
    const sent = [];
    let lastError;
    for (const openId of recipients) {
      try {
        const data = await call("POST", "/open-apis/im/v1/messages", {
          receive_id: openId,
          msg_type: "interactive",
          content,
          // 每个收件人各一个确定性 uuid（#31）：共用一个会被飞书应用级去重吃掉第二个审批人的卡。
          uuid: cardUuid(record.requestId, attempt, openId)
        }, { receive_id_type: "open_id" });
        if (data?.message_id !== void 0) sent.push(data.message_id);
      } catch (error2) {
        lastError = error2;
        options.onFailure?.(error2, { requestId: record.requestId, path: "/im/v1/messages" });
      }
    }
    if (sent.length === 0) {
      throw lastError instanceof Error ? lastError : new Error(`approval channel: all ${String(recipients.length)} pushes failed for ${record.requestId}`);
    }
    await ledger.putCard({ requestId: record.requestId, messageIds: sent, recipientIds: [...recipients], pushedAt: now() });
    return sent;
  }
  async function patch(record, state, messageIds) {
    const content = JSON.stringify(buildApprovalCard(record, state, options.policy));
    for (const messageId of messageIds) {
      const path = `/open-apis/im/v1/messages/${messageId}`;
      try {
        await call("PATCH", path, { content });
      } catch (error2) {
        options.onFailure?.(error2, { requestId: record.requestId, path });
      }
    }
  }
  async function sendText(openId, text, requestId) {
    try {
      await call("POST", "/open-apis/im/v1/messages", {
        receive_id: openId,
        msg_type: "text",
        content: JSON.stringify({ text }),
        // 通知类文本每次都是新内容，uuid 用「这条通知是关于谁的 + 发给谁」—— 重复投递（崩溃恢复）会被吃掉，
        // 而多个收件人各一个 uuid 才不会被应用级去重丢掉后面那几条（#31 的撤回通知同理）。
        uuid: noticeUuid(requestId, openId)
      }, { receive_id_type: "open_id" });
    } catch (error2) {
      options.onFailure?.(error2, { requestId, path: "/im/v1/messages" });
    }
  }
  function handleOf(requestId) {
    const handle = ledger.cardHandle(requestId);
    if (handle === void 0) throw new Error(`approval channel: no card handle for ${requestId}`);
    return handle;
  }
  const card = (requestId) => ({
    cardId: requestId,
    /**
     * 飞书的点击**不经过渠道**：它由回调路由送进来（§3.7），再经窗口登记表交给还在等的 responder。
     * 所以这里的等待只被 abort 结束 —— 造一张"自己永远不会被点到"的卡是有意的，不是没实现：
     * 渠道若也去等一次点击，同一个决定就有两个来源竞争，而台账只该有一个赢家（§3.6）。
     */
    waitForClick: (signal) => new Promise((resolve2) => {
      if (signal.aborted) {
        resolve2(void 0);
        return;
      }
      signal.addEventListener("abort", () => resolve2(void 0), { once: true });
    })
  });
  return {
    async send(record) {
      await sendCard(record, { kind: "awaiting" }, "push");
      return card(record.requestId);
    },
    async update(clicked, text) {
      const record = ledger.get(clicked.cardId);
      if (record === void 0) throw new Error(`approval channel: record ${clicked.cardId} vanished`);
      await patch(record, { kind: "decided", text }, handleOf(clicked.cardId).messageIds);
    },
    /**
     * 就地改成「转后台」态：文案换了，**按钮不置灰**（`deferred` 不是终态）。
     *
     * 之所以不能顺手用 `recall`：真渠道的撤回是 `DELETE`，删掉的正是这条审批唯一能点的入口，
     * 而台账此时仍然收迟到批准（`expired` / `recalled` 都在 `isDecidable` 里），§3.5 的催办还会
     * 为它再推一张卡。于是「转后台」变成一句永远兑现不了的承诺（§8 第 8 步 F-E，假渠道测不出：
     * 它的 recall 只是打个标记）。
     */
    async defer(clicked, text) {
      const record = ledger.get(clicked.cardId);
      if (record === void 0) throw new Error(`approval channel: record ${clicked.cardId} vanished`);
      await patch(record, { kind: "deferred", text }, handleOf(clicked.cardId).messageIds);
    },
    async recall(clicked, text) {
      const record = ledger.get(clicked.cardId);
      if (record === void 0) throw new Error(`approval channel: record ${clicked.cardId} vanished`);
      const handle = handleOf(clicked.cardId);
      for (const messageId of handle.messageIds) {
        try {
          await call("DELETE", `/open-apis/im/v1/messages/${messageId}`);
        } catch (error2) {
          if (error2 instanceof FeishuApiError && alreadyGoneCodes.has(error2.code)) continue;
          throw error2;
        }
      }
      for (const openId of handle.recipientIds) await sendText(openId, text, clicked.cardId);
    },
    async pushReminder(record) {
      const previous = ledger.cardHandle(record.requestId)?.messageIds ?? [];
      await sendCard(record, { kind: "reminded" }, "remind");
      await patch(record, { kind: "superseded" }, previous);
    },
    async markExpired(record) {
      const handle = ledger.cardHandle(record.requestId);
      if (handle !== void 0) await patch(record, { kind: "expired" }, handle.messageIds);
      const openId = options.initiatorOf(record);
      if (openId !== void 0) {
        await sendText(openId, `\u4F60\u7684\u8BF7\u6C42\u300C${record.actionSummary}\u300D\u56E0\u672A\u83B7\u6279\u51C6\u5DF2\u8FC7\u671F\uFF08\u7F16\u53F7 ${record.requestId}\uFF09\uFF0C\u4EFB\u52A1\u672A\u5B8C\u6210\u3002`, record.requestId);
      }
    }
  };
}
function sessionRelaxationCount(ledger) {
  return (record) => ledger.requestsOf(record.sessionId).filter((other) => (other.status === "approved" || other.status === "consumed") && other.toolArgs !== null && typeof other.toolArgs === "object" && !Array.isArray(other.toolArgs) && "sandbox_permissions" in other.toolArgs).length;
}
function sessionRepeatAsks(ledger) {
  const digestOf = (record) => argsDigest(record.toolArgs);
  return (record) => {
    const digest = digestOf(record);
    return ledger.requestsOf(record.sessionId).filter((other) => other.toolName === record.toolName && digestOf(other) === digest).length;
  };
}
function installFeishuApprovalChannel(options) {
  return createFeishuApprovalChannel({
    ...options,
    policy: options.policy ?? {
      relaxationCount: sessionRelaxationCount(options.ledger),
      repeatAsks: sessionRepeatAsks(options.ledger)
    }
  });
}

// apps/fom-client/plugins/office-approval/feishu-transport-http.ts
var FEISHU_BASE_URL = "https://open.feishu.cn";
var DEFAULT_TIMEOUT_MS = 1e4;
var FeishuTransportError = class extends Error {
  constructor(message, path, options) {
    super(`feishu transport failed at ${path}: ${message}`, options);
    this.path = path;
    this.name = "FeishuTransportError";
  }
};
function asNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function asString(value) {
  return typeof value === "string" ? value : void 0;
}
function createHttpFeishuTransport(options = {}) {
  const base = (options.baseUrl ?? FEISHU_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  return async (call) => {
    const url = new URL(base + call.path);
    for (const [key, value] of Object.entries(call.query ?? {})) url.searchParams.set(key, value);
    const headers = { "Content-Type": "application/json; charset=utf-8" };
    if (call.token !== void 0) headers.Authorization = `Bearer ${call.token}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    let response;
    try {
      response = await doFetch(url.toString(), {
        method: call.method,
        headers,
        signal: controller.signal,
        ...call.body === void 0 ? {} : { body: JSON.stringify(call.body) }
      });
    } catch (error2) {
      throw new FeishuTransportError(
        controller.signal.aborted ? `aborted after ${timeoutMs}ms (\u53EF\u80FD\u5DF2\u9001\u8FBE\uFF0C\u91CD\u53D1\u7531 uuid \u53BB\u91CD\u515C\u5E95)` : String(error2),
        call.path,
        { cause: error2 }
      );
    } finally {
      clearTimeout(timer);
    }
    let body;
    let text;
    try {
      text = await response.text();
    } catch (error2) {
      throw new FeishuTransportError(`unreadable body (http ${response.status})`, call.path, { cause: error2 });
    }
    if (text !== void 0 && text.length > 0) {
      try {
        const parsed = JSON.parse(text);
        body = parsed !== null && typeof parsed === "object" ? parsed : void 0;
      } catch (error2) {
        throw new FeishuTransportError(
          `response is not JSON (http ${response.status}): ${text.slice(0, 120)}`,
          call.path,
          { cause: error2 }
        );
      }
      if (body === void 0) {
        throw new FeishuTransportError(`response JSON is not an object (http ${response.status})`, call.path);
      }
    }
    const code = asNumber(body?.code, response.ok ? 0 : response.status);
    const msg = asString(body?.msg) ?? asString(body?.message) ?? (response.ok ? void 0 : `http ${response.status} ${response.statusText}`);
    const reply = { status: response.status, code, msg };
    if (body?.data !== void 0) reply.data = body.data;
    if (typeof body?.tenant_access_token === "string") reply.tenant_access_token = body.tenant_access_token;
    if (typeof body?.expire === "number") reply.expire = body.expire;
    return reply;
  };
}

// apps/fom-client/plugins/office-approval/index.ts
var rules = builtinRiskRules;
var CardSinkChannel = class {
  constructor(ctx, path) {
    this.ctx = ctx;
    this.path = path;
  }
  directoryReady;
  /** 催办重推（sweeper 的 `remind` 目标）。 */
  async pushReminder(record) {
    await this.write("remind", record.requestId, { status: record.status, toolName: record.toolName });
  }
  /** 过期作废（sweeper 的 `expire` 目标）。 */
  async markExpired(record) {
    await this.write("expire", record.requestId, { status: record.status, toolName: record.toolName });
  }
  async send(record) {
    await this.write("send", record.requestId, {
      riskLevel: record.riskLevel,
      actionSummary: record.actionSummary,
      // 参数原文只进台账，不进卡片正文（§4 最小暴露）；这里落的是给人看的那句摘要。
      windowEndsAt: record.windowEndsAt
    });
    return {
      cardId: `sink-${record.requestId}`,
      // 这张卡自己不等点击：点击是经回调路由 → 恢复路径 → `windows.settle` 进来的，
      // 所以渠道这一侧只在窗口 abort 时收摊。
      waitForClick: (signal) => new Promise((resolve2) => {
        if (signal.aborted) return resolve2(void 0);
        signal.addEventListener("abort", () => resolve2(void 0), { once: true });
      })
    };
  }
  async update(card, text) {
    await this.write("update", card.cardId, { text });
  }
  /** 「转后台但仍可批准」：与 `recall` 的区别就是要留下能点的那张卡（F-E）。 */
  async defer(card, text) {
    await this.write("defer", card.cardId, { text });
  }
  async recall(card, text) {
    await this.write("recall", card.cardId, { text });
  }
  async write(kind, id, payload) {
    const line = JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), kind, id, payload });
    this.ctx.logger("office-approval").info(`card ${kind} ${id}`);
    if (this.path === "") return;
    await (this.directoryReady ??= mkdir(dirname(resolve(this.path)), { recursive: true }).then(() => {
    }));
    await appendFile(resolve(this.path), `${line}
`, "utf8");
  }
};
var PLATFORM_TOKEN_REF = "FOM_PLATFORM_TOKEN";
function createCardChannel(ctx, config, ledger, report) {
  if (config.feishuAppId === "") return new CardSinkChannel(ctx, config.cardSink);
  const appSecret = process.env[config.feishuAppSecretEnv] ?? "";
  if (appSecret === "") {
    throw new Error(`office-approval: feishuAppId \u5DF2\u914D\u7F6E\uFF0C\u4F46\u73AF\u5883\u53D8\u91CF ${config.feishuAppSecretEnv} \u662F\u7A7A\u7684`);
  }
  const transport = createHttpFeishuTransport({ timeoutMs: config.feishuTimeoutMs });
  const recipients = () => config.approvers.length > 0 ? config.approvers : void 0;
  return installFeishuApprovalChannel({
    transport,
    tokens: createTenantTokenSource(transport, config.feishuAppId, appSecret),
    ledger,
    recipientsOf: recipients,
    // 本机单人部署：发起人与审批人是同一个人。多用户要接产品目录（U2），不在这里猜。
    initiatorOf: () => config.approvers[0],
    // 送卡失败在决策上是「交棒给内核原生面板」（E13，不放宽审批），但在运维上必须留下声音：
    // 否则「审批人没收到卡」与「审批人没看见卡」在台账里长得一模一样 —— 第 8 步真进程冒烟
    // 就是靠这条才看出卡片根本没发出去（`onFailure` 不接，渠道只把错误吞进 per-recipient 循环）。
    onFailure: (error2, info) => report(`${info.path} ${info.requestId}: ${String(error2)}`)
  });
}
async function apply(ctx, config) {
  const logger = ctx.logger("office-approval");
  if (config.approvalMode !== "im" && config.approvalMode !== "native") {
    throw new Error(`office-approval: approvalMode \u975E\u6CD5\uFF08\u987B\u4E3A im/native\uFF09\uFF1A${config.approvalMode}`);
  }
  const native = config.approvalMode === "native";
  const ledger = new ApprovalLedger(await ctx.storageDomain.open(approvalLedgerDomain));
  const resolver = createTenantResolver({
    ...config.tenantId === "" ? {} : { fixed: config.tenantId },
    readToken: async () => {
      const credentials = ctx.get("credentials");
      return (await credentials?.resolve?.(PLATFORM_TOKEN_REF))?.value ?? "";
    },
    parseTenant: (token) => {
      const user = userFromToken(token);
      return user === null || user.tenantId === "" ? void 0 : user.tenantId;
    },
    onError: (error2) => logger.warn(`\u79DF\u6237\u89E3\u6790\u5931\u8D25\uFF08\u4FDD\u7559\u65E7\u503C\uFF09\uFF1A${String(error2?.message ?? error2)}`)
  });
  await resolver.refresh();
  const provideGateMarker = () => {
    ctx.effect(() => ctx.reflect.provide("officeRiskGate", {
      installed: true,
      /** 当前解析到的租户（诊断/联调用；解不出 ⇒ undefined）。 */
      tenant: () => resolver.current()?.tenantId
    }));
  };
  if (native) {
    installRiskGate(ctx, {
      ledger,
      rules,
      tenantOf: () => resolver.current(),
      windowMs: config.windowMs,
      ...config.gatedTools.length === 0 ? {} : { gatedTools: config.gatedTools }
    });
    provideGateMarker();
    logger.info(`\u5BA1\u6279\u5C42\u5DF2\u88C5\u914D\uFF08**\u53EA\u88C5\u95F8**\uFF09\uFF1A\u79DF\u6237 ${config.tenantId === "" ? "\u53D6\u81EA\u5E73\u53F0\u4EE4\u724C JWT" : config.tenantId}\uFF0C\u7A97\u53E3 ${config.windowMs}ms\uFF0C\u8303\u56F4 ${config.gatedTools.length === 0 ? "\u5168\u91CF" : config.gatedTools.join("/")}\uFF0C\u5BA1\u6279\u843D**\u5185\u6838\u539F\u751F\u9762\u677F**\uFF1B\u6211\u4EEC\u81EA\u5DF1\u7684\u53F0\u8D26\u505C\u5728 pending\uFF08\u51B3\u7B56\u53EA\u5728\u5185\u6838\u4F1A\u8BDD\u65E5\u5FD7\u91CC\uFF09`);
    logger.info(`\u6863\u4F4D\u58F0\u660E\uFF1A${config.neverSessionsInformativeNotice}`);
    return () => {
    };
  }
  const windows = new PendingApprovalWindows();
  const channel = createCardChannel(ctx, config, ledger, (message) => {
    logger.warn(message);
    process.stderr.write(`[office-approval] ${message}
`);
  });
  const targets = {
    remind: (record) => channel.pushReminder(record),
    expire: (record) => channel.markExpired(record)
  };
  const recover = createApprovalRecovery({
    ledger,
    windows,
    // 冷会话必须能被起来（E3）：这一句是本步要验的头号问题，测试端口给不了答案。
    resolveAgent: async (sessionId) => {
      const controller = ctx.get("sessionController");
      if (controller === void 0) return void 0;
      const found = await controller.resolveAgent(SessionId2(sessionId));
      return found.error === void 0 ? found.agent : void 0;
    },
    // 投递确认 = 至少有一个持久化应答者（`packages/core/session/src/index.ts:1190`）。
    flush: (session) => ctx.sessions.flush(session),
    onFailure: (failure, event, error2) => {
      logger.warn(`\u6062\u590D\u5931\u8D25 ${failure} ${event.record.requestId}: ${String(error2 ?? "\u65E0\u5F02\u5E38")}`);
    }
  });
  installRiskGate(ctx, {
    ledger,
    rules,
    // 租户来自配置或平台令牌 JWT（见上面的 resolver）。
    tenantOf: () => resolver.current(),
    windowMs: config.windowMs,
    ...config.gatedTools.length === 0 ? {} : { gatedTools: config.gatedTools }
  });
  provideGateMarker();
  const releaseResponder = installApprovalResponder(ctx, {
    ledger,
    channel,
    windows,
    onHandoffError: (requestId, error2) => logger.warn(`\u4EA4\u68D2\u9000\u5F79\u5931\u8D25 ${requestId}: ${String(error2)}`)
  });
  if ((process.env[config.verificationTokenEnv] ?? "") === "") {
    logger.warn(`\u56DE\u8C03\u9A8C\u7B7E\u5BC6\u94A5\u672A\u914D\u7F6E\uFF08\u73AF\u5883\u53D8\u91CF ${config.verificationTokenEnv}\uFF09\u21D2 \u56DE\u8C03\u4E00\u5F8B 401\uFF0CIM \u6279\u51C6\u5165\u53E3\u4E0D\u53EF\u7528\uFF1B\u5185\u6838\u539F\u751F\u8BE2\u95EE\u9762\u677F\u7167\u65E7`);
  }
  installApprovalCallbackRoute(ctx, {
    ledger,
    tenantId: config.tenantId,
    path: config.callbackPath,
    verificationToken: () => process.env[config.verificationTokenEnv] ?? "",
    // 名单解析不出来 → 拒（§4）。L4「只认 owner」要接产品字典，本步不硬编码。
    approversOf: () => config.approvers.length > 0 ? config.approvers : void 0,
    // U10：落账前先试交活窗口。有在飞的调用在等这条记录 → 当场兑现、不落批件（存在期因此不存在），
    // 卡片由 responder 置灰；没人等才落批件走唤醒重放。同步，不 await（3 秒窗口）。
    handToWindow: (requestId, handoff) => windows.settle(requestId, handoff),
    onSettled: (event) => recover(event),
    onSettledError: (error2, event) => logger.warn(`\u843D\u8D26\u540E\u901A\u77E5\u5931\u8D25 ${event.record.requestId}: ${String(error2)}`),
    onAuditError: (error2, denial) => logger.warn(`\u8D8A\u6743\u5BA1\u8BA1\u5199\u4E0D\u4E0B\u53BB ${denial.requestId}: ${String(error2)}`)
  });
  const releaseSweeper = installApprovalSweeper(ctx, {
    ledger,
    targets,
    remindAfterMs: config.remindAfterMs,
    onFailure: (event) => logger.warn(`\u50AC\u529E/\u8FC7\u671F\u5931\u8D25 ${event.requestId}/${event.stage}: ${String(event.error)}`)
  });
  logger.info(`\u5BA1\u6279\u5C42\u5DF2\u88C5\u914D\uFF1A\u79DF\u6237 ${config.tenantId}\uFF0C\u7A97\u53E3 ${config.windowMs}ms\uFF0C\u56DE\u8C03 ${config.callbackPath}\uFF0C\u6E20\u9053 ${config.feishuAppId === "" ? "cardSink" : `feishu/${config.feishuAppId}`}\uFF0C\u5BA1\u6279\u4EBA ${config.approvers.length} \u4EBA`);
  logger.info(`\u6863\u4F4D\u58F0\u660E\uFF1A${config.neverSessionsInformativeNotice}`);
  return () => {
    releaseResponder();
    releaseSweeper();
  };
}
var Config = z3.object({
  tenantId: z3.string().default(""),
  windowMs: z3.number().min(1e3).max(6e5).default(9e4),
  remindAfterMs: z3.number().min(6e4).default(30 * 6e4),
  callbackPath: z3.string().default("/office/approval/callback"),
  verificationTokenEnv: z3.string().default("OFFICE_APPROVAL_VERIFICATION_TOKEN"),
  approvers: z3.array(z3.string()).default([]),
  feishuAppId: z3.string().default(""),
  feishuAppSecretEnv: z3.string().default("FEISHU_APP_SECRET"),
  feishuTimeoutMs: z3.number().min(500).max(3e4).default(1e4),
  cardSink: z3.string().default(""),
  neverSessionsInformativeNotice: z3.string().default(
    "\u7B56\u7565\u4E3A never \u7684\u4F1A\u8BDD\u4E0D\u53D1\u653E\u53EF\u6279\u51C6\u7684\u5BA1\u6279\uFF1A\u8FD9\u91CC\u51FA\u73B0\u7684\u4EFB\u4F55\u5361\u7247\u53EA\u662F\u4FE1\u606F\u6027\u6B8B\u7559\uFF0C\u70B9\u6279\u51C6\u4E0D\u4F1A\u6267\u884C\u4EFB\u4F55\u52A8\u4F5C\u3002"
  ),
  approvalMode: z3.string().default("im"),
  gatedTools: z3.array(z3.string()).default([])
});
var OfficeApproval = {
  name: "office-approval",
  inject: ["tools", "approval", "sessions", "storageDomain", "schedule", "sessionController", "sessionPersistence"],
  Config,
  apply
};
var index_default = OfficeApproval;
export {
  OfficeApproval,
  PLATFORM_TOKEN_REF,
  apply,
  index_default as default
};

// apps/fom-client/plugins/office-feishu/index.ts
import z2 from "@deepseek-ai/schemastery";

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
    } catch (error) {
      throw new FeishuTransportError(
        controller.signal.aborted ? `aborted after ${timeoutMs}ms (\u53EF\u80FD\u5DF2\u9001\u8FBE\uFF0C\u91CD\u53D1\u7531 uuid \u53BB\u91CD\u515C\u5E95)` : String(error),
        call.path,
        { cause: error }
      );
    } finally {
      clearTimeout(timer);
    }
    let body;
    let text;
    try {
      text = await response.text();
    } catch (error) {
      throw new FeishuTransportError(`unreadable body (http ${response.status})`, call.path, { cause: error });
    }
    if (text !== void 0 && text.length > 0) {
      try {
        const parsed = JSON.parse(text);
        body = parsed !== null && typeof parsed === "object" ? parsed : void 0;
      } catch (error) {
        throw new FeishuTransportError(
          `response is not JSON (http ${response.status}): ${text.slice(0, 120)}`,
          call.path,
          { cause: error }
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

// apps/fom-client/plugins/office-approval/ledger.ts
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

// apps/fom-client/plugins/office-approval/feishu-channel.ts
var FeishuApiError = class extends Error {
  constructor(code, message, path) {
    super(`feishu ${code} at ${path}: ${message}`);
    this.code = code;
    this.path = path;
    this.name = "FeishuApiError";
  }
};
var tokenInvalidCodes = /* @__PURE__ */ new Set([99991651, 99991663]);
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

// apps/fom-client/plugins/office-feishu/tools.ts
import { defineTool } from "@deepseek-ai/dsh-tools";
function parseDocToken(input) {
  const trimmed = input.trim();
  const match = /feishu\.(?:cn|com)\/(?:docx|docs|wiki)\/([A-Za-z0-9]+)/.exec(trimmed);
  return match?.[1] ?? trimmed;
}
function parseBitableApp(input) {
  const trimmed = input.trim();
  const match = /feishu\.(?:cn|com)\/base\/([A-Za-z0-9]+)/.exec(trimmed);
  return match?.[1] ?? trimmed;
}
function parseBitableTable(input) {
  const trimmed = input.trim();
  const match = /[?&]table=([A-Za-z0-9]+)/.exec(trimmed);
  return match?.[1] ?? trimmed;
}
function parseCalendarId(input) {
  const trimmed = input.trim();
  const match = /[?&]calendarId=([^&\s]+)/.exec(trimmed);
  return match?.[1] ?? trimmed;
}
function firstCalendarId(data) {
  const record = data;
  const direct = record?.calendar?.calendar_id;
  if (typeof direct === "string") return direct;
  const nested = record?.calendars?.[0]?.calendar?.calendar_id;
  return typeof nested === "string" ? nested : "";
}
function unixOr(input, fallback) {
  const value = typeof input === "number" ? input : Number(String(input ?? ""));
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
function resolveBitableTarget(appInput, tableArg) {
  const appToken = parseBitableApp(appInput);
  let tableId = typeof tableArg === "string" && tableArg !== "" ? parseBitableTable(tableArg) : "";
  if (tableId === "" && /[?&]table=/.test(appInput)) tableId = parseBitableTable(appInput);
  if (appToken === "" || tableId === "") {
    throw new Error("\u9700\u8981\u591A\u7EF4\u8868\u683C\u94FE\u63A5\uFF08\u542B ?table=\uFF09\u6216 app_token + table_id");
  }
  return { appToken, tableId };
}
function createFeishuTools(transport, tokens) {
  const request = async (options) => {
    const call = (token) => transport({
      method: options.method,
      path: options.path,
      token,
      ...options.body === void 0 ? {} : { body: options.body },
      ...options.query === void 0 ? {} : { query: options.query }
    });
    let reply = await call(await tokens.token());
    if (tokenInvalidCodes.has(reply.code)) {
      tokens.invalidate();
      reply = await call(await tokens.token());
    }
    if (reply.code !== 0) throw new FeishuApiError(reply.code, reply.msg ?? "feishu request failed", options.path);
    return reply.data;
  };
  const resolveCalendar = async (calArg) => {
    const raw = String(calArg ?? "");
    let calendarId = raw === "" ? "" : parseCalendarId(raw);
    if (calendarId === "") {
      const primary = await request({ method: "POST", path: "/open-apis/calendar/v4/calendars/primary" });
      calendarId = firstCalendarId(primary);
      if (calendarId === "") throw new Error("\u6CA1\u62FF\u5230\u4E3B\u65E5\u5386 id\uFF08\u53EF\u663E\u5F0F\u4F20 calendar\uFF09");
    }
    return calendarId;
  };
  const docRead = defineTool({
    name: "feishu_doc_read",
    description: "\u8BFB\u4E00\u7BC7\u98DE\u4E66\u4E91\u6587\u6863\uFF08docx\uFF09\u7684\u7EAF\u6587\u672C\u6B63\u6587\u3002\u53C2\u6570\u7ED9\u6587\u6863\u94FE\u63A5\u6216 document_id\u3002\u53EA\u8BFB\uFF0C\u4E0D\u4FEE\u6539\u4EFB\u4F55\u4E1C\u897F\u3002",
    parameters: {
      doc: {
        type: "string",
        required: true,
        description: "\u98DE\u4E66\u6587\u6863\u94FE\u63A5\uFF08\u5F62\u5982 https://xxx.feishu.cn/docx/<id>\uFF09\u6216 document_id"
      }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          documentId: { type: "string", required: true },
          text: { type: "string", required: true }
        }
      },
      render: (_args, value) => [{ type: "text", text: value.text }]
    },
    async execute(args) {
      const documentId = parseDocToken(String(args.doc ?? ""));
      if (documentId === "") throw new Error("feishu_doc_read: \u9700\u8981\u4E00\u4E2A\u6587\u6863\u94FE\u63A5\u6216 document_id");
      const path = `/open-apis/docx/v1/documents/${documentId}/raw_content`;
      const data = await request({ method: "GET", path });
      return { documentId, text: typeof data?.content === "string" ? data.content : "" };
    }
  });
  const docCreate = defineTool({
    name: "feishu_doc_create",
    description: "\u65B0\u5EFA\u4E00\u7BC7\u98DE\u4E66\u4E91\u6587\u6863\uFF08docx\uFF09\u3002\u53EF\u7ED9\u6807\u9898\u4E0E\u6B63\u6587\uFF1B\u6B63\u6587\u6309\u6362\u884C\u62C6\u6210\u591A\u4E2A\u6BB5\u843D\u5199\u5165\u3002**\u5199\u5165\u662F\u5BF9\u5916\u53EF\u89C1\u52A8\u4F5C**\uFF08\u4F1A\u95EE\u4EBA\u6279\u51C6\uFF09\u3002",
    parameters: {
      title: { type: "string", required: true, description: "\u6587\u6863\u6807\u9898" },
      content: { type: "string", description: "\u6B63\u6587\uFF08\u53EF\u9009\uFF09\uFF1B\u6309\u6362\u884C\u62C6\u6210\u591A\u4E2A\u6BB5\u843D\uFF0C\u6700\u591A 50 \u6BB5" },
      folder_token: { type: "string", description: "\u76EE\u6807\u6587\u4EF6\u5939 token\uFF08\u53EF\u9009\uFF09\uFF1B\u4E0D\u7ED9\u5219\u5EFA\u5728\u5E94\u7528\u9ED8\u8BA4\u7A7A\u95F4" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          documentId: { type: "string", required: true },
          title: { type: "string", required: true },
          paragraphs: { type: "number", required: true }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: `\u5DF2\u521B\u5EFA\u98DE\u4E66\u6587\u6863\u300C${value.title}\u300D\uFF1Adocument_id=${value.documentId}\uFF08\u5199\u5165 ${String(value.paragraphs)} \u6BB5\uFF09`
      }]
    },
    async execute(args) {
      const title = String(args.title ?? "").trim();
      if (title === "") throw new Error("feishu_doc_create: title \u4E0D\u80FD\u4E3A\u7A7A");
      const folder = args.folder_token;
      const created = await request({
        method: "POST",
        path: "/open-apis/docx/v1/documents",
        body: { title, ...typeof folder === "string" && folder !== "" ? { folder_token: folder } : {} }
      });
      const documentId = typeof created?.document?.document_id === "string" ? created.document.document_id : "";
      if (documentId === "") throw new Error("feishu_doc_create: \u521B\u5EFA\u6210\u529F\u4F46\u6CA1\u62FF\u5230 document_id");
      const raw = args.content;
      const paragraphs = typeof raw === "string" && raw !== "" ? raw.split("\n").map((line) => line.trimEnd()).filter((line) => line !== "").slice(0, 50) : [];
      if (paragraphs.length > 0) {
        await request({
          method: "POST",
          path: `/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`,
          query: { document_revision_id: "-1" },
          body: {
            index: 0,
            children: paragraphs.map((text) => ({
              block_type: 2,
              text: { elements: [{ text_run: { content: text } }], style: {} }
            }))
          }
        });
      }
      return { documentId, title, paragraphs: paragraphs.length };
    }
  });
  const bitableListRecords = defineTool({
    name: "feishu_bitable_list_records",
    description: "\u5217\u51FA\u98DE\u4E66\u591A\u7EF4\u8868\u683C\uFF08Base\uFF09\u67D0\u5F20\u6570\u636E\u8868\u7684\u8BB0\u5F55\u3002\u53C2\u6570\u7ED9\u591A\u7EF4\u8868\u683C\u94FE\u63A5\uFF08\u542B ?table=\uFF09\u6216 app_token + table_id\u3002\u53EA\u8BFB\u3002",
    parameters: {
      app: { type: "string", required: true, description: "\u591A\u7EF4\u8868\u683C\u94FE\u63A5\uFF08https://xxx.feishu.cn/base/<app_token>?table=<table_id>\uFF09\u6216 app_token" },
      table: { type: "string", description: "\u6570\u636E\u8868 table_id\uFF08\u94FE\u63A5\u91CC\u5E26 ?table= \u65F6\u53EF\u7701\uFF09" },
      page_size: { type: "number", description: "\u6BCF\u9875\u6761\u6570\uFF0C\u9ED8\u8BA4 100\uFF0C\u6700\u5927 500" },
      page_token: { type: "string", description: "\u7FFB\u9875\u6807\u8BB0\uFF08\u4E0A\u4E00\u6B21\u8FD4\u56DE\u7684 pageToken\uFF09" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          appToken: { type: "string", required: true },
          tableId: { type: "string", required: true },
          count: { type: "number", required: true },
          hasMore: { type: "boolean", required: true },
          pageToken: { type: "string", required: true },
          recordsJson: { type: "string", required: true }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: `\u591A\u7EF4\u8868\u683C ${value.tableId}\uFF1A${String(value.count)} \u6761${value.hasMore ? "\uFF08\u8FD8\u6709\u66F4\u591A\uFF0CpageToken=" + value.pageToken + "\uFF09" : ""}
${value.recordsJson}`
      }]
    },
    async execute(args) {
      const { appToken, tableId } = resolveBitableTarget(
        String(args.app ?? ""),
        args.table
      );
      const size = Number(args.page_size ?? 100);
      const pageSize = Number.isSafeInteger(size) && size > 0 ? Math.min(size, 500) : 100;
      const token = args.page_token;
      const query = { page_size: String(pageSize) };
      if (typeof token === "string" && token !== "") query.page_token = token;
      const data = await request({
        method: "GET",
        path: `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
        query
      });
      const records = Array.isArray(data?.items) ? data.items : [];
      return {
        appToken,
        tableId,
        count: records.length,
        hasMore: data?.has_more === true,
        pageToken: typeof data?.page_token === "string" ? data.page_token : "",
        recordsJson: JSON.stringify(records)
      };
    }
  });
  const calendarListEvents = defineTool({
    name: "feishu_calendar_list_events",
    description: "\u5217\u51FA\u98DE\u4E66\u65E5\u5386\u5728\u7ED9\u5B9A\u65F6\u95F4\u8303\u56F4\u5185\u7684\u65E5\u7A0B\u3002calendar \u7701\u7565\u65F6\u7528\u4E3B\u65E5\u5386\uFF1Bstart_time/end_time \u4E3A Unix \u79D2\uFF08\u7701\u7565\u5219\u9ED8\u8BA4\u8FD1 7 \u5929\uFF09\u3002\u53EA\u8BFB\u3002",
    parameters: {
      calendar: { type: "string", description: "\u65E5\u5386 id\uFF08\u7701\u7565\u5219\u7528\u4E3B\u65E5\u5386\uFF09" },
      start_time: { type: "string", description: "\u5F00\u59CB\u65F6\u95F4\uFF0CUnix \u79D2\uFF08\u7701\u7565\u5219\u9ED8\u8BA4\u8FD1 7 \u5929\uFF09" },
      end_time: { type: "string", description: "\u7ED3\u675F\u65F6\u95F4\uFF0CUnix \u79D2\uFF08\u7701\u7565\u5219\u9ED8\u8BA4\u73B0\u5728\uFF09" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          calendarId: { type: "string", required: true },
          count: { type: "number", required: true },
          itemsJson: { type: "string", required: true }
        }
      },
      render: (_args, value) => [{
        type: "text",
        text: `\u65E5\u5386 ${value.calendarId}\uFF1A${String(value.count)} \u4E2A\u65E5\u7A0B
${value.itemsJson}`
      }]
    },
    async execute(args) {
      const calendarId = await resolveCalendar(args.calendar);
      const now = Math.floor(Date.now() / 1e3);
      const start = unixOr(args.start_time, now - 7 * 86400);
      const end = unixOr(args.end_time, now);
      const data = await request({
        method: "GET",
        path: `/open-apis/calendar/v4/calendars/${calendarId}/events`,
        query: { start_time: String(start), end_time: String(end) }
      });
      const items = Array.isArray(data?.items) ? data.items : [];
      return { calendarId, count: items.length, itemsJson: JSON.stringify(items) };
    }
  });
  const bitableCreateRecord = defineTool({
    name: "feishu_bitable_create_record",
    description: "\u5F80\u98DE\u4E66\u591A\u7EF4\u8868\u683C\uFF08Base\uFF09\u67D0\u5F20\u6570\u636E\u8868**\u65B0\u589E\u4E00\u6761\u8BB0\u5F55**\u3002\u53C2\u6570\u7ED9\u591A\u7EF4\u8868\u683C\u94FE\u63A5\uFF08\u542B ?table=\uFF09\u6216 app_token + table_id\uFF0Cfields \u662F\u300C\u5217\u540D \u2192 \u503C\u300D\u7684\u5BF9\u8C61\u3002**\u5199\u5165\u662F\u5BF9\u5916\u53EF\u89C1\u52A8\u4F5C\uFF08\u4F1A\u95EE\u4EBA\u6279\u51C6\uFF09\u3002**",
    parameters: {
      app: { type: "string", required: true, description: "\u591A\u7EF4\u8868\u683C\u94FE\u63A5\uFF08\u542B ?table=\uFF09\u6216 app_token" },
      table: { type: "string", description: "\u6570\u636E\u8868 table_id\uFF08\u94FE\u63A5\u91CC\u5E26 ?table= \u65F6\u53EF\u7701\uFF09" },
      fields: { type: "object", additionalProperties: true, required: true, description: '\u8981\u5199\u5165\u7684\u5B57\u6BB5\uFF08\u5217\u540D \u2192 \u503C\uFF09\uFF0C\u5982 {"\u5F85\u529E\u4E8B\u9879":"\u5199\u5468\u62A5","\u72B6\u6001":"\u8FDB\u884C\u4E2D"}' }
    },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { recordId: { type: "string", required: true } } },
      render: (_args, value) => [{ type: "text", text: `\u5DF2\u5199\u5165\u8BB0\u5F55 ${value.recordId}` }]
    },
    async execute(args) {
      const { appToken, tableId } = resolveBitableTarget(
        String(args.app ?? ""),
        args.table
      );
      const fields = args.fields;
      if (typeof fields !== "object" || fields === null || Array.isArray(fields)) {
        throw new Error("feishu_bitable_create_record: fields \u5FC5\u987B\u662F\u300C\u5217\u540D \u2192 \u503C\u300D\u7684\u5BF9\u8C61");
      }
      const data = await request({
        method: "POST",
        path: `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
        body: { fields }
      });
      const recordId = typeof data?.record?.record_id === "string" ? data.record.record_id : "";
      if (recordId === "") throw new Error("feishu_bitable_create_record: \u5199\u5165\u6210\u529F\u4F46\u6CA1\u62FF\u5230 record_id");
      return { recordId };
    }
  });
  const calendarCreateEvent = defineTool({
    name: "feishu_calendar_create_event",
    description: "\u5728\u98DE\u4E66\u65E5\u5386\u4E0A**\u65B0\u5EFA\u4E00\u4E2A\u65E5\u7A0B**\u3002start_time/end_time \u4E3A Unix \u79D2\uFF1Bcalendar \u7701\u7565\u65F6\u7528\u4E3B\u65E5\u5386\u3002**\u5199\u5165\u662F\u5BF9\u5916\u53EF\u89C1\u52A8\u4F5C\uFF08\u4F1A\u95EE\u4EBA\u6279\u51C6\uFF09\u3002**",
    parameters: {
      calendar: { type: "string", description: "\u65E5\u5386 id\uFF08\u7701\u7565\u5219\u7528\u4E3B\u65E5\u5386\uFF09" },
      summary: { type: "string", required: true, description: "\u65E5\u7A0B\u6807\u9898" },
      description: { type: "string", description: "\u65E5\u7A0B\u63CF\u8FF0" },
      start_time: { type: "string", required: true, description: "\u5F00\u59CB\u65F6\u95F4\uFF0CUnix \u79D2" },
      end_time: { type: "string", required: true, description: "\u7ED3\u675F\u65F6\u95F4\uFF0CUnix \u79D2" },
      timezone: { type: "string", description: "IANA \u65F6\u533A\uFF0C\u9ED8\u8BA4 Asia/Shanghai" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { eventId: { type: "string", required: true }, calendarId: { type: "string", required: true } }
      },
      render: (_args, value) => [{ type: "text", text: `\u5DF2\u5EFA\u65E5\u7A0B ${value.eventId}\uFF08\u65E5\u5386 ${value.calendarId}\uFF09` }]
    },
    async execute(args) {
      const summary = String(args.summary ?? "").trim();
      if (summary === "") throw new Error("feishu_calendar_create_event: summary \u4E0D\u80FD\u4E3A\u7A7A");
      const calendarId = await resolveCalendar(args.calendar);
      const tzArg = args.timezone;
      const timezone = typeof tzArg === "string" && tzArg !== "" ? tzArg : "Asia/Shanghai";
      const start = unixOr(args.start_time, 0);
      const end = unixOr(args.end_time, 0);
      if (start <= 0 || end <= 0) throw new Error("feishu_calendar_create_event: start_time / end_time \u5FC5\u987B\u662F\u975E\u96F6 Unix \u79D2");
      const description = args.description;
      const data = await request({
        method: "POST",
        path: `/open-apis/calendar/v4/calendars/${calendarId}/events`,
        body: {
          summary,
          ...typeof description === "string" && description !== "" ? { description } : {},
          start_time: { timestamp: String(start), timezone },
          end_time: { timestamp: String(end), timezone }
        }
      });
      const eventId = typeof data?.event?.event_id === "string" ? data.event.event_id : "";
      if (eventId === "") throw new Error("feishu_calendar_create_event: \u521B\u5EFA\u6210\u529F\u4F46\u6CA1\u62FF\u5230 event_id");
      return { eventId, calendarId };
    }
  });
  return { docRead, docCreate, bitableListRecords, bitableCreateRecord, calendarListEvents, calendarCreateEvent };
}

// apps/fom-client/plugins/office-feishu/index.ts
var Config = z2.object({
  feishuAppId: z2.string().default(""),
  feishuAppSecretRef: z2.string().default("FOM_FEISHU_APP_SECRET"),
  feishuAppSecretEnv: z2.string().default("FEISHU_APP_SECRET"),
  baseUrl: z2.string().default("https://open.feishu.cn"),
  readOnly: z2.boolean().default(false)
});
async function readAppSecret(ctx, config) {
  if (config.feishuAppSecretRef !== "") {
    const credentials = ctx.get("credentials");
    const stored = (await credentials?.resolve?.(config.feishuAppSecretRef))?.value ?? "";
    if (stored !== "") return { value: stored, source: "credentials" };
  }
  const fromEnv = process.env[config.feishuAppSecretEnv] ?? "";
  if (fromEnv !== "") return { value: fromEnv, source: "env" };
  return { value: "", source: "none" };
}
async function apply(ctx, config) {
  const logger = ctx.logger("office-feishu");
  const report = (message) => {
    logger.info(message);
    process.stderr.write(`[office-feishu] ${message}
`);
  };
  if (config.feishuAppId === "") {
    report("\u98DE\u4E66\u5DE5\u5177\u5C42\u4F11\u7720\uFF1A\u672A\u914D\u7F6E feishuAppId\uFF08\u4F01\u4E1A\u914D\u597D\u81EA\u5DF1\u7684\u98DE\u4E66\u5E94\u7528\u540E\u5373\u53EF\u542F\u7528\uFF09");
    return () => {
    };
  }
  const secret = await readAppSecret(ctx, config);
  if (secret.value === "") {
    throw new Error(
      `office-feishu: feishuAppId \u5DF2\u914D\u7F6E\uFF0C\u4F46 App Secret \u53D6\u4E0D\u5230\uFF08\u51ED\u636E\u5E93 ref "${config.feishuAppSecretRef}" \u4E0E\u73AF\u5883\u53D8\u91CF "${config.feishuAppSecretEnv}" \u90FD\u662F\u7A7A\u7684\uFF09`
    );
  }
  const transport = createHttpFeishuTransport({ baseUrl: config.baseUrl });
  const tokens = createTenantTokenSource(transport, config.feishuAppId, secret.value);
  const tools = createFeishuTools(transport, tokens);
  const readReleases = [
    ctx.tools.register(tools.docRead),
    ctx.tools.register(tools.bitableListRecords),
    ctx.tools.register(tools.calendarListEvents)
  ];
  if (config.readOnly) {
    report(`\u98DE\u4E66\u5DE5\u5177\u5C42\u5DF2\u88C5\u914D\uFF08\u53EA\u8BFB\uFF0CSecret \u6765\u6E90\uFF1A${secret.source}\uFF09\uFF1A\u8BFB L0\uFF08doc_read / bitable_list_records / calendar_list_events\uFF09`);
    return () => {
      for (const release of readReleases) release();
    };
  }
  ctx.inject(["officeRiskGate"], (scoped) => {
    scoped.effect(() => {
      const releases = [
        ctx.tools.register(tools.docCreate),
        ctx.tools.register(tools.bitableCreateRecord),
        ctx.tools.register(tools.calendarCreateEvent)
      ];
      report("\u98DE\u4E66\u5199\u5DE5\u5177\uFF08L2\uFF09\u5DF2\u88C5\u914D\uFF1Adoc_create / bitable_create_record / calendar_create_event");
      return () => {
        for (const release of releases) release();
      };
    }, "office-feishu: \u5199\u5DE5\u5177\uFF08L2\uFF0C\u9700\u98CE\u9669\u95F8 officeRiskGate\uFF09");
  });
  report(`\u98DE\u4E66\u5DE5\u5177\u5C42\u5DF2\u88C5\u914D\uFF08Secret \u6765\u6E90\uFF1A${secret.source}\uFF09\uFF1A\u8BFB L0 \u5DF2\u6CE8\u518C\uFF1B\u5199 L2 \u7B49\u98CE\u9669\u95F8\uFF08officeRiskGate\uFF09\u51FA\u73B0\u540E\u6CE8\u518C \u2014\u2014 \u95F8\u4E0D\u5728\u5219\u5199\u5DE5\u5177\u4E0D\u6CE8\u518C\uFF08fail-closed\uFF09`);
  return () => {
    for (const release of readReleases) release();
  };
}
var OfficeFeishu = {
  name: "office-feishu",
  inject: ["tools", "credentials"],
  Config,
  apply
};
var index_default = OfficeFeishu;
export {
  OfficeFeishu,
  apply,
  index_default as default,
  readAppSecret
};

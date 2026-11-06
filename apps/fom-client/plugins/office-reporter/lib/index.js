// apps/fom-client/plugins/office-reporter/index.ts
import { homedir } from "node:os";
import { join as join3 } from "node:path";

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

// apps/fom-client/plugins/office-reporter/transport.ts
function createMemoryTransport() {
  const sent = [];
  return {
    sent,
    async send(messages) {
      for (const message of messages) sent.push(message);
    }
  };
}
var ReportTransportError = class extends Error {
  /**
   * @param message - 人类可读的失败说明（含路径与状态）。
   * @param status - HTTP 状态码。
   * @param retryAfterMs - 平台 `Retry-After` 解析出的等待毫秒（没有/不可解析 ⇒ undefined）。
   */
  constructor(message, status, retryAfterMs) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.name = "ReportTransportError";
  }
};
function parseRetryAfter(value) {
  if (value === null) return void 0;
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) return void 0;
  const seconds = Number(trimmed);
  return Number.isSafeInteger(seconds) ? seconds * 1e3 : void 0;
}
function createHttpTransport(deps) {
  const doFetch = deps.fetchImpl ?? fetch;
  const base = deps.platformUrl.replace(/\/+$/u, "");
  return {
    async send(messages) {
      if (messages.length === 0) return;
      const token = await deps.token();
      const headers = { "content-type": "application/json" };
      if (token !== "") headers.authorization = `Bearer ${token}`;
      for (const message of messages) {
        const path = message.type === "usage.report" ? "/api/report/usage" : "/api/report/audit";
        const { type: _type, ...body } = message;
        const res = await doFetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
        if (!res.ok) {
          const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
          throw new ReportTransportError(
            `\u4E0A\u62A5\u5931\u8D25\uFF08${path}\uFF09\uFF1AHTTP ${res.status}${retryAfterMs === void 0 ? "" : `\uFF08Retry-After ${retryAfterMs / 1e3}s\uFF09`}`,
            res.status,
            ...retryAfterMs === void 0 ? [] : [retryAfterMs]
          );
        }
      }
    }
  };
}

// apps/fom-client/plugins/office-reporter/reporter.ts
function createMemoryQueue() {
  let queue = [];
  const watermarks = /* @__PURE__ */ new Map();
  return {
    enqueue(messages) {
      queue.push(...messages);
    },
    pending() {
      return queue;
    },
    ack(count) {
      queue = queue.slice(count);
    },
    watermark(sessionId) {
      return watermarks.get(sessionId) ?? 0;
    },
    advance(sessionId, seq) {
      if (seq > (watermarks.get(sessionId) ?? 0)) watermarks.set(sessionId, seq);
    }
  };
}
var DEFAULT_MAX_PER_FLUSH = 50;
function createReporter(deps) {
  const maxPerFlush = deps.maxPerFlush ?? DEFAULT_MAX_PER_FLUSH;
  const now = deps.now ?? (() => Date.now());
  let retryAfterMs;
  let blockedUntil;
  return {
    report(messages) {
      if (messages.length > 0) deps.queue.enqueue(messages);
    },
    pendingCount() {
      return deps.queue.pending().length;
    },
    async flush() {
      const all = deps.queue.pending();
      if (all.length === 0) return { sent: 0, pending: 0 };
      const batch = all.slice(0, maxPerFlush);
      try {
        await deps.transport.send(batch);
      } catch (error) {
        retryAfterMs = error instanceof ReportTransportError ? error.retryAfterMs : void 0;
        blockedUntil = retryAfterMs === void 0 ? void 0 : now() + retryAfterMs;
        throw error;
      }
      deps.queue.ack(batch.length);
      retryAfterMs = void 0;
      blockedUntil = void 0;
      return { sent: batch.length, pending: deps.queue.pending().length };
    },
    watermark: (sessionId) => deps.queue.watermark(sessionId),
    advance: (sessionId, seq) => {
      deps.queue.advance(sessionId, seq);
    },
    retryAfterMs: () => retryAfterMs,
    blockedUntilMs: () => blockedUntil
  };
}

// apps/fom-client/plugins/office-reporter/trigger.ts
import { join as join2 } from "node:path";

// apps/fom-client/plugins/office-audit/audit.ts
var PATH_KEYS = ["file_path", "path", "paths", "files", "dir", "directory", "cwd"];
function asString(value) {
  return typeof value === "string" ? value : void 0;
}
function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function asObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function extractPaths(argumentsJson) {
  if (argumentsJson === void 0) return [];
  let parsed;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return [];
  }
  const obj = asObject(parsed);
  if (obj === void 0) return [];
  const out = [];
  for (const key of PATH_KEYS) {
    const value = obj[key];
    if (typeof value === "string" && value.length > 0) out.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && item.length > 0) out.push(item);
      }
    }
  }
  return out;
}
function toAuditEntry(record, tenant, sessionId) {
  const type = record.type;
  if (type === void 0) return void 0;
  const data = record.data ?? {};
  const detail = detailOf(type, data);
  if (detail === void 0) return void 0;
  return {
    tenant,
    sessionId,
    seq: asNumber(record.seq) ?? 0,
    time: asNumber(record.time) ?? 0,
    type,
    detail
  };
}
function detailOf(type, data) {
  switch (type) {
    case "tool/call": {
      const name2 = asString(data.name);
      if (name2 === void 0) return void 0;
      return { kind: "tool", phase: "call", name: name2, callId: asString(data.callId) ?? "", paths: extractPaths(asString(data.arguments)) };
    }
    case "tool/result": {
      const error = asObject(data.error);
      const errorCode = error === void 0 ? void 0 : asString(error.code);
      return {
        kind: "tool",
        phase: "result",
        turn: asNumber(data.turn) ?? -1,
        step: asNumber(data.step) ?? -1,
        ok: error === void 0,
        ...errorCode === void 0 ? {} : { errorCode }
      };
    }
    case "approval/asked": {
      const id = asString(data.id);
      const toolName = asString(data.toolName);
      if (id === void 0 || toolName === void 0) return void 0;
      const reason = asString(data.reason);
      return { kind: "approval", phase: "asked", id, toolName, ...reason === void 0 ? {} : { reason } };
    }
    case "approval/decided": {
      const id = asString(data.id);
      const outcome = asString(data.outcome);
      if (id === void 0 || outcome === void 0) return void 0;
      return { kind: "approval", phase: "decided", id, outcome };
    }
    case "hook/invoked": {
      const point = asString(data.point);
      const handlerId = asString(data.handlerId);
      if (point === void 0 || handlerId === void 0) return void 0;
      return { kind: "hook", phase: "invoked", point, handlerId };
    }
    case "hook/result": {
      const point = asString(data.point);
      const handlerId = asString(data.handlerId);
      if (point === void 0 || handlerId === void 0) return void 0;
      const decision = asString(data.decision);
      const durationMs = asNumber(data.durationMs);
      return {
        kind: "hook",
        phase: "result",
        point,
        handlerId,
        ...decision === void 0 ? {} : { decision },
        ...durationMs === void 0 ? {} : { durationMs }
      };
    }
    case "permission/preset": {
      const preset = asString(data.preset);
      return preset === void 0 ? void 0 : { kind: "permission", preset };
    }
    case "sandbox/mode": {
      const mode = asString(data.mode);
      return mode === void 0 ? void 0 : { kind: "sandbox", mode };
    }
    case "model/selection": {
      const provider = asString(data.provider);
      const model = asString(data.model);
      if (provider === void 0 || model === void 0) return void 0;
      return { kind: "model", provider, model };
    }
    case "turn/end": {
      const reason = asObject(data.reason);
      return { kind: "turn", turn: asNumber(data.turn) ?? -1, reason: (reason === void 0 ? void 0 : asString(reason.kind)) ?? "unknown" };
    }
    default:
      return void 0;
  }
}
function foldAudit(log, tenant) {
  const out = [];
  for (const record of log.records) {
    const entry = toAuditEntry(record, tenant, log.sessionId);
    if (entry !== void 0) out.push(entry);
  }
  return out;
}
function collectAudit(logSet, tenant) {
  const out = [];
  for (const log of logSet.sessions) out.push(...foldAudit(log, tenant));
  return out;
}

// apps/fom-client/plugins/office-meter/reader.ts
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

// apps/fom-client/plugins/office-meter/usage.ts
var EMPTY = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  billedInputTokens: 0
});

// apps/fom-client/plugins/office-meter/reader.ts
var SESSION_FILE = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/;
function generationOf(name2) {
  const match = SESSION_FILE.exec(name2);
  if (match === null) return -1;
  return match[1] === void 0 ? 0 : Number(match[1]);
}
function decodeFile(path) {
  const buf = readFileSync(path);
  return path.endsWith(".zstd") ? zstdDecompressSync(buf).toString("utf8") : buf.toString("utf8");
}
function parseRecords(text) {
  const records = [];
  let bad = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      bad += 1;
    }
  }
  return { records, bad };
}
function readSessionLogs(sessionsRoot) {
  const sessions = [];
  let files = 0;
  let badLines = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    let best;
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const gen = generationOf(entry.name);
      if (gen < 0) continue;
      if (best === void 0 || gen > best.gen) best = { name: entry.name, gen };
    }
    if (best !== void 0) {
      const path = join(dir, best.name);
      const { records, bad } = parseRecords(decodeFile(path));
      badLines += bad;
      files += 1;
      sessions.push({ sessionId: basename(dir), records });
    }
  };
  walk(sessionsRoot);
  return { sessions, files, badLines };
}

// apps/fom-client/plugins/office-reporter/messages.ts
function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function str(value) {
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function iso(time) {
  return new Date(num(time)).toISOString();
}
function toUsageReports(sessionId, records, ctx) {
  const committed = /* @__PURE__ */ new Set();
  const key = (turn, step) => `${String(num(turn))}/${String(num(step))}`;
  for (const record of records) {
    if (record.type === "assistant/message" && record.data?.usage !== void 0) {
      committed.add(key(record.data.turn, record.data.step));
    }
  }
  const out = [];
  for (const record of records) {
    const usage = record.data?.usage;
    if (usage === void 0) continue;
    const isMessage = record.type === "assistant/message";
    const isAttempt = record.type === "assistant/attempt" && !committed.has(key(record.data?.turn, record.data?.step));
    if (!isMessage && !isAttempt) continue;
    out.push({
      type: "usage.report",
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      sessionId,
      turn: num(record.data?.turn),
      step: num(record.data?.step),
      attempt: num(record.data?.attempt),
      model: str(record.data?.model) ?? ctx.defaultModel ?? "",
      source: ctx.source,
      inputTokens: num(usage.inputTokens),
      outputTokens: num(usage.outputTokens),
      cacheReadTokens: num(usage.cacheReadTokens),
      cacheWriteTokens: num(usage.cacheWriteTokens),
      at: iso(record.time)
    });
  }
  return out;
}
function toAuditReports(entries, ctx) {
  return entries.map((entry) => ({
    type: "audit.report",
    tenantId: entry.tenant || ctx.tenantId,
    userId: ctx.userId,
    sessionId: entry.sessionId,
    seq: entry.seq,
    time: entry.time,
    eventType: entry.type,
    detail: entry.detail ?? {}
  }));
}

// apps/fom-client/plugins/office-reporter/collect.ts
function collectSession(reporter, sessionId, records, ctx, auditEntries = []) {
  const messages = [...toUsageReports(sessionId, records, ctx), ...toAuditReports(auditEntries, ctx)];
  if (messages.length > 0) reporter.report(messages);
  return messages.length;
}

// apps/fom-client/plugins/office-reporter/trigger.ts
function createTurnEndTrigger(deps) {
  const debounceMs = deps.debounceMs ?? 800;
  let timer = null;
  return {
    onEvent: (type) => {
      if (type !== "turn/end") return;
      if (deps.blocked?.() === true) return;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void deps.sync().catch(() => {
        });
      }, debounceMs);
    },
    dispose: () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    }
  };
}
async function syncSessionLogs(reporter, home, ctx) {
  const logSet = readSessionLogs(join2(home, "sessions"));
  const auditBySession = /* @__PURE__ */ new Map();
  for (const entry of collectAudit(logSet, ctx.tenantId)) {
    const list = auditBySession.get(entry.sessionId);
    if (list === void 0) auditBySession.set(entry.sessionId, [entry]);
    else list.push(entry);
  }
  let reported = 0;
  const pendingWatermarks = [];
  for (const log of logSet.sessions) {
    const watermark = reporter.watermark(log.sessionId);
    const fresh = (auditBySession.get(log.sessionId) ?? []).filter((entry) => entry.seq > watermark);
    if (fresh.length > 0) {
      pendingWatermarks.push({ sessionId: log.sessionId, seq: Math.max(...fresh.map((entry) => entry.seq)) });
    }
    reported += collectSession(reporter, log.sessionId, log.records, ctx, fresh);
  }
  try {
    const flushed = await reporter.flush();
    for (const item of pendingWatermarks) reporter.advance(item.sessionId, item.seq);
    return { sessions: logSet.sessions.length, reported, sent: flushed.sent, pending: flushed.pending, audited: pendingWatermarks.length };
  } catch (error) {
    const hint = reporter.retryAfterMs();
    return {
      sessions: logSet.sessions.length,
      reported,
      sent: 0,
      pending: reporter.pendingCount(),
      audited: 0,
      error: String(error?.message ?? error),
      ...hint === void 0 ? {} : { retryAfterMs: hint }
    };
  }
}

// apps/fom-client/plugins/office-reporter/ws-transport.ts
function defaultSocket(url) {
  const Impl = globalThis.WebSocket;
  if (Impl === void 0) throw new Error("office-reporter: \u65E0\u5168\u5C40 WebSocket\uFF0C\u8BF7\u6CE8\u5165 createSocket");
  return new Impl(url);
}
function createWsTransport(options) {
  const createSocket = options.createSocket ?? defaultSocket;
  const openTimeoutMs = options.openTimeoutMs ?? 1e4;
  const target = options.url + (options.token === void 0 ? "" : `?token=${encodeURIComponent(options.token)}`);
  let socket = null;
  const connect = () => new Promise((resolve, reject) => {
    const ws = createSocket(target);
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
      }
      reject(new Error("office-reporter: ws \u8FDE\u63A5\u8D85\u65F6"));
    }, openTimeoutMs);
    ws.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        socket = ws;
        resolve(ws);
      },
      { once: true }
    );
    ws.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("office-reporter: ws \u8FDE\u63A5\u5931\u8D25"));
      },
      { once: true }
    );
  });
  return {
    async send(messages) {
      const ws = socket ?? await connect();
      for (const message of messages) ws.send(JSON.stringify(message));
    },
    close() {
      try {
        socket?.close();
      } catch {
      }
      socket = null;
    }
  };
}

// apps/fom-client/plugins/office-reporter/index.ts
var PLATFORM_TOKEN_REF = "FOM_PLATFORM_TOKEN";
var FLUSH_ROUTE = "/api/office/reporter/flush";
var SYNC_ROUTE = "/api/office/reporter/sync";
function dshHome() {
  const home = process.env.DSH_HOME;
  return home !== void 0 && home !== "" ? home : join3(homedir(), ".dsh");
}
var name = "office-reporter";
function apply(ctx, config = {}) {
  const mode = config.transport ?? (config.platformUrl === void 0 ? "memory" : "http");
  const tokenRef = config.tokenRef ?? PLATFORM_TOKEN_REF;
  const readToken = async () => {
    const credentials = ctx.get("credentials");
    return (await credentials?.resolve?.(tokenRef))?.value ?? "";
  };
  let transport;
  if (mode === "http") {
    if (config.platformUrl === void 0 || config.platformUrl === "") {
      throw new Error("office-reporter: transport=http \u9700\u8981 platformUrl");
    }
    transport = createHttpTransport({ platformUrl: config.platformUrl, token: readToken });
  } else if (mode === "ws") {
    transport = createWsTransport({ url: config.platformUrl ?? "", ...config.token === void 0 ? {} : { token: config.token } });
  } else {
    transport = createMemoryTransport();
  }
  const reporter = createReporter({
    transport,
    queue: createMemoryQueue(),
    ...config.maxPerFlush === void 0 ? {} : { maxPerFlush: config.maxPerFlush }
  });
  ctx.reflect.provide("officeReporter", reporter);
  const sync = async () => {
    const token = await readToken();
    const user = token === "" ? null : userFromToken(token);
    if (user === null || user.tenantId === "" || user.userId === "") {
      throw new Error("\u672A\u767B\u5F55\uFF1A\u62FF\u4E0D\u5230\u5E73\u53F0\u8EAB\u4EFD\uFF08\u5148\u5728\u300C\u767B\u5F55\u300D\u9762\u677F\u767B\u5F55\uFF09");
    }
    return syncSessionLogs(reporter, dshHome(), {
      tenantId: user.tenantId,
      userId: user.userId,
      source: "platform",
      ...config.defaultModel === void 0 || config.defaultModel === "" ? {} : { defaultModel: config.defaultModel }
    });
  };
  if (mode === "memory") return;
  const intervalMs = config.syncIntervalMs ?? 0;
  if (intervalMs > 0) {
    const timer = setInterval(() => {
      void sync().catch(() => {
      });
    }, intervalMs);
    ctx.effect(() => () => {
      clearInterval(timer);
    }, "office-reporter: \u5B9A\u65F6\u6298\u53E0\u89E6\u53D1");
  }
  if (config.syncOnTurnEnd ?? true) {
    const trigger = createTurnEndTrigger({
      sync,
      ...config.turnEndDebounceMs === void 0 ? {} : { debounceMs: config.turnEndDebounceMs },
      // 限流退避中就别再冲：等下一次 turn/end（或定时触发）——消息留在队列，不丢。
      blocked: () => {
        const until = reporter.blockedUntilMs();
        return until !== void 0 && Date.now() < until;
      }
    });
    ctx.effect(() => {
      const off = ctx.on("session/event", (...args) => {
        trigger.onEvent(args[1]?.type);
      });
      return () => {
        off();
        trigger.dispose();
      };
    }, "office-reporter: turn/end \u4E8B\u4EF6\u9A71\u52A8\u89E6\u53D1");
  }
  ctx.inject(["connection"], (connCtx) => {
    connCtx.effect(() => {
      const conn = connCtx.get("connection");
      if (conn === void 0) return () => {
      };
      const reply = (body, status) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      const disposeFlush = conn.fetch.register({
        path: FLUSH_ROUTE,
        methods: ["POST"],
        requestBody: "buffered",
        fetch: async () => {
          try {
            return reply({ ok: true, ...await reporter.flush() }, 200);
          } catch (error) {
            const hint = reporter.retryAfterMs();
            return reply({
              ok: false,
              message: String(error?.message ?? error),
              pending: reporter.pendingCount(),
              ...hint === void 0 ? {} : { retryAfterMs: hint }
            }, 200);
          }
        }
      });
      const disposeSync = conn.fetch.register({
        path: SYNC_ROUTE,
        methods: ["POST"],
        requestBody: "buffered",
        fetch: async () => {
          try {
            const result = await sync();
            return reply({ ok: result.error === void 0, ...result }, 200);
          } catch (error) {
            return reply({ ok: false, message: String(error?.message ?? error) }, 200);
          }
        }
      });
      return () => {
        void disposeFlush();
        void disposeSync();
      };
    }, "office-reporter: flush / sync \u8DEF\u7531");
  });
}
var index_default = { name, apply };
export {
  DEFAULT_MAX_PER_FLUSH,
  FLUSH_ROUTE,
  PLATFORM_TOKEN_REF,
  ReportTransportError,
  SYNC_ROUTE,
  apply,
  collectSession,
  createHttpTransport,
  createMemoryQueue,
  createMemoryTransport,
  createReporter,
  createTurnEndTrigger,
  createWsTransport,
  index_default as default,
  name,
  parseRetryAfter,
  syncSessionLogs,
  toAuditReports,
  toUsageReports
};

// apps/fom-client/plugins/office-channel/index.ts
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import z from "@deepseek-ai/schemastery";
import { SessionId } from "@deepseek-ai/dsh-session";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

// apps/fom-client/plugins/office-channel/relay.ts
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function str(value) {
  return typeof value === "string" ? value : "";
}
function relayMessage(frame) {
  const channel = str(frame.channel);
  const openId = str(frame.openId);
  if (channel === "" || openId === "") return void 0;
  const payload = asRecord(frame.payload) ?? {};
  const text = str(payload.text).trim();
  if (text === "") return void 0;
  const chatId = str(payload.chatId);
  return {
    chatKey: `${channel}:${chatId === "" ? openId : chatId}`,
    channel,
    openId,
    chatId,
    text,
    messageId: str(payload.messageId)
  };
}

// apps/fom-client/plugins/office-channel/reply.ts
function assistantText(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const item = block;
    if (item.type === "text" && typeof item.text === "string" && item.text.trim() !== "") parts.push(item.text);
  }
  return parts.join("\n").trim();
}
var ImReplyCollector = class {
  last = /* @__PURE__ */ new Map();
  /** 吃一条内核会话事件；需要回消息时返回正文。 */
  onEvent(sessionId, type, data) {
    if (sessionId === "") return void 0;
    if (type === "assistant/message") {
      const text = assistantText(data?.message);
      if (text !== "") this.last.set(sessionId, text);
      return void 0;
    }
    if (type === "turn/end") {
      const text = this.last.get(sessionId);
      this.last.delete(sessionId);
      return text === "" ? void 0 : text;
    }
    return void 0;
  }
  /** 会话不再照看（例如被关掉）⇒ 丢掉残留。 */
  forget(sessionId) {
    this.last.delete(sessionId);
  }
};

// apps/fom-client/plugins/office-channel/index.ts
var Config = z.object({
  platformUrl: z.string().default(""),
  tokenRef: z.string().default("FOM_PLATFORM_TOKEN"),
  enabled: z.boolean().default(true),
  heartbeatMs: z.number().default(3e4),
  reconnectBaseMs: z.number().default(5e3),
  loginRetryMs: z.number().default(5e3),
  idleProbeMs: z.number().default(3e5),
  deviceId: z.string().default("")
});
var name = "office-channel";
var inject = ["agents", "agentDefaultModel"];
function toWsUrl(platformUrl) {
  const base = platformUrl.replace(/\/+$/u, "").replace(/^http/u, "ws");
  return `${base}/api/ws`;
}
function defaultSocket(url) {
  const Impl = globalThis.WebSocket;
  if (Impl === void 0) throw new Error("office-channel: \u65E0\u5168\u5C40 WebSocket");
  return new Impl(url);
}
function isLocalModeChosen(path) {
  try {
    const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
    const raw = readFileSync(path ?? join(home, "office", "login-mode.json"), "utf8");
    const parsed = JSON.parse(raw);
    return parsed.mode === "local";
  } catch {
    return false;
  }
}
function apply(ctx, config, deps = {}) {
  const logger = ctx.logger("office-channel");
  const createSocket = deps.createSocket ?? defaultSocket;
  const localChosen = deps.isLocalMode ?? (() => isLocalModeChosen());
  const report = (message) => {
    const line = `[office-channel] ${(/* @__PURE__ */ new Date()).toISOString()} ${message}
`;
    process.stderr.write(line);
    try {
      const home = process.env.DSH_HOME !== void 0 && process.env.DSH_HOME !== "" ? process.env.DSH_HOME : join(homedir(), ".dsh");
      const dir = join(home, "logs");
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "office-channel.log"), line);
    } catch {
    }
  };
  if (!config.enabled || config.platformUrl === "") {
    report("\u4F11\u7720\uFF1A\u672A\u914D platformUrl \u6216 enabled=false");
    return;
  }
  const sessions = /* @__PURE__ */ new Map();
  const relayed = /* @__PURE__ */ new Map();
  const replyCollector = new ImReplyCollector();
  let sendUpstream;
  const downlinkHandlers = /* @__PURE__ */ new Map();
  const MAX_REPLY_CHARS = 3500;
  const target = toWsUrl(config.platformUrl);
  const deviceId = config.deviceId === "" ? `desktop-${hostname()}` : config.deviceId;
  const readToken = async () => {
    const credentials = ctx.get("credentials");
    return (await credentials?.resolve?.(config.tokenRef))?.value ?? "";
  };
  const withTimeout = async (label, promise, ms = 1e4) => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} \u8D85\u65F6\uFF08${ms}ms \u672A\u8FD4\u56DE\uFF09`)), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer !== void 0) clearTimeout(timer);
    }
  };
  const deliverRelay = async (message) => {
    const declared = ctx;
    const agents = declared.agents ?? ctx.get("agents");
    const defaults = declared.agentDefaultModel ?? ctx.get("agentDefaultModel");
    if (agents?.create === void 0) {
      report(`IM \u4E2D\u7EE7\u5230\u4E86\uFF0C\u4F46\u4F1A\u8BDD\u670D\u52A1\u4E0D\u9F50 \u21D2 \u4E22\u5F03\uFF08agents/create=${typeof agents?.create}\uFF09`);
      return;
    }
    const existing = sessions.get(message.chatKey);
    let sessionId;
    let agent;
    try {
      if (existing === void 0) {
        const selection = defaults?.currentSelection?.();
        if (selection === void 0) {
          report("IM \u4E2D\u7EE7\u5230\u4E86\uFF0C\u4F46\u6CA1\u6709\u7F3A\u7701\u6A21\u578B\uFF08agentDefaultModel \u53D6\u4E0D\u5230\uFF09\u21D2 \u4E22\u5F03");
          return;
        }
        sessionId = `session-${randomUUID()}`;
        const handle = await withTimeout("\u5EFA\u4F1A\u8BDD\uFF08agents.create\uFF09", agents.create({
          sessionId,
          agentOptions: selection,
          meta: { cwd: process.cwd() }
        }));
        agent = handle.agent;
        if (agent !== void 0) {
          sessions.set(message.chatKey, sessionId);
          report(`IM \u4F1A\u8BDD\u5DF2\u5EFA\uFF1A${message.chatKey} \u2192 ${sessionId}`);
        }
      } else {
        sessionId = existing;
        agent = agents.get?.(SessionId(sessionId));
      }
    } catch (error) {
      report(`IM \u4F1A\u8BDD\u51C6\u5907\u5931\u8D25\uFF1A${String(error?.message ?? error)}`);
      return;
    }
    if (agent === void 0) {
      report(`IM \u6D88\u606F\u6295\u9012\u5931\u8D25\uFF1A\u4F1A\u8BDD ${sessionId} \u4E0D\u53EF\u7528`);
      return;
    }
    agent.followup(createUserMessage({
      content: [{ type: "text", text: message.text }],
      source: { kind: "user" }
    }));
    relayed.set(sessionId, {
      channel: message.channel,
      openId: message.openId,
      chatId: message.chatId,
      messageId: message.messageId
    });
    report(`IM \u6D88\u606F\u5DF2\u6295\u8FDB\u4F1A\u8BDD ${sessionId}\uFF08${message.channel}/${message.openId}\uFF09`);
  };
  const dispatch = async (raw) => {
    let frame;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
      frame = parsed;
    } catch {
      logger.warn("IM \u901A\u9053\u6536\u5230\u65E0\u6CD5\u89E3\u6790\u7684\u5E27\uFF0C\u5DF2\u5FFD\u7565");
      return;
    }
    const handlers = downlinkHandlers.get(String(frame.type));
    if (handlers !== void 0) {
      for (const handler of [...handlers]) {
        try {
          handler(frame);
        } catch (error) {
          logger.warn(`\u4E0B\u884C\u5904\u7406\u5668\u51FA\u9519\uFF08${String(frame.type)}\uFF09\uFF1A${String(error?.message ?? error)}`);
        }
      }
    }
    switch (frame.type) {
      case "im.relay": {
        const message = relayMessage(frame);
        if (message === void 0) {
          logger.warn("im.relay \u5E27\u5F62\u72B6\u4E0D\u5BF9\uFF08\u7F3A channel/openId/text\uFF09\uFF0C\u5DF2\u5FFD\u7565");
          return;
        }
        await deliverRelay(message);
        break;
      }
      case "ack":
        logger.info(`\u6536\u5230 ack\uFF1A${String(frame.ref)}`);
        break;
      case "quota.downlink":
      case "catalog.downlink":
      case "config.downlink":
      case "subscription.downlink":
        logger.info(`\u6536\u5230 ${String(frame.type)}\uFF08\u6682\u672A\u6D88\u8D39\uFF0C\u89C1 IM\u5BF9\u63A5\u73B0\u72B6\u4E0E\u8BA1\u5212 \xA74 IM-5 \u5F85\u505A\u2461\uFF09`);
        break;
      default:
        logger.warn(`IM \u901A\u9053\u6536\u5230\u672A\u77E5\u6D88\u606F\u7C7B\u578B ${String(frame.type)}\uFF0C\u5DF2\u5FFD\u7565`);
        break;
    }
  };
  ctx.effect(() => {
    const off = ctx.on("session/event", (session, event) => {
      const sessionId = String(session?.id ?? "");
      const type = String(event?.type ?? "");
      const text = replyCollector.onEvent(sessionId, type, event?.data);
      if (text === void 0) return;
      const route = relayed.get(sessionId);
      if (route === void 0) return;
      if (sendUpstream === void 0) {
        report(`IM \u56DE\u590D\u672A\u53D1\u51FA\uFF1A\u901A\u9053\u672A\u8FDE\uFF08${sessionId}\uFF09`);
        return;
      }
      const body = text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS)}\u2026\uFF08\u5DF2\u622A\u65AD\uFF09` : text;
      sendUpstream({
        type: "im.reply",
        channel: route.channel,
        chatId: route.chatId,
        messageId: route.messageId,
        text: body
      });
      report(`IM \u56DE\u590D\u5DF2\u53D1\u56DE\uFF08${route.channel}/${route.chatId}\uFF0C${body.length} \u5B57\uFF09`);
    });
    return () => off();
  }, "office-channel: \u56DE\u6D88\u606F\uFF08turn/end\uFF09");
  ctx.effect(() => ctx.reflect.provide("officeImChannel", {
    send: (frame) => {
      if (sendUpstream === void 0) return false;
      sendUpstream(frame);
      return true;
    },
    onDownlink: (type, handler) => {
      const set = downlinkHandlers.get(type) ?? /* @__PURE__ */ new Set();
      set.add(handler);
      downlinkHandlers.set(type, set);
      return () => {
        set.delete(handler);
      };
    }
  }), "office-channel: \u5BF9\u5916\u63D0\u4F9B officeImChannel\uFF08\u63A7\u5236\u5E27\u6536\u53D1\uFF09");
  ctx.effect(() => {
    let socket = null;
    let heartbeat = null;
    let reconnect = null;
    let attempt = 0;
    let stopped = false;
    let firstIdle = true;
    const cleanup = () => {
      sendUpstream = void 0;
      if (heartbeat !== null) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      if (reconnect !== null) {
        clearTimeout(reconnect);
        reconnect = null;
      }
      const current = socket;
      socket = null;
      try {
        current?.close();
      } catch {
      }
    };
    const scheduleReconnect = () => {
      if (stopped || reconnect !== null) return;
      const delay = Math.min(config.reconnectBaseMs * 2 ** attempt, 6e4);
      attempt += 1;
      report(`${Math.round(delay / 1e3)} \u79D2\u540E\u91CD\u8FDE\uFF08\u7B2C ${attempt} \u6B21\uFF09`);
      reconnect = setTimeout(() => {
        reconnect = null;
        void connect();
      }, delay);
    };
    const connect = async () => {
      if (stopped) return;
      let token = "";
      try {
        token = await readToken();
      } catch (error) {
        report(`\u8BFB\u5E73\u53F0\u4EE4\u724C\u5931\u8D25\uFF1A${String(error?.message ?? error)}`);
      }
      if (token === "") {
        const local = localChosen();
        const delay = local ? config.idleProbeMs : config.loginRetryMs;
        if (!local || firstIdle) {
          firstIdle = false;
          report(
            local ? `\u672C\u5730\u6A21\u5F0F\uFF08\u672A\u767B\u5F55\uFF09\uFF0C${Math.round(delay / 1e3)}s \u540E\u4F4E\u9891\u63A2\u6D4B\u4EE4\u724C` : `\u7B49\u767B\u5F55\uFF08\u51ED\u636E\u91CC\u8FD8\u6CA1\u6709\u5E73\u53F0\u4EE4\u724C\uFF09\uFF0C${Math.round(delay / 1e3)}s \u540E\u91CD\u8BD5`
          );
        }
        if (stopped || reconnect !== null) return;
        reconnect = setTimeout(() => {
          reconnect = null;
          void connect();
        }, delay);
        return;
      }
      firstIdle = false;
      let ws;
      try {
        ws = createSocket(`${target}?token=${encodeURIComponent(token)}`);
      } catch (error) {
        report(`\u8D77\u4E0D\u6765\uFF1A${String(error?.message ?? error)}`);
        scheduleReconnect();
        return;
      }
      socket = ws;
      ws.addEventListener("open", () => {
        attempt = 0;
        sendUpstream = (frame) => {
          try {
            ws.send(JSON.stringify(frame));
          } catch (error) {
            report(`\u4E0A\u884C\u53D1\u9001\u5931\u8D25\uFF1A${String(error?.message ?? error)}`);
          }
        };
        report(`\u5DF2\u8FDE\u4E0A\u5E73\u53F0 ${target}`);
        if (config.heartbeatMs > 0) {
          heartbeat = setInterval(() => {
            try {
              ws.send(JSON.stringify({ type: "heartbeat", deviceId }));
            } catch {
            }
          }, config.heartbeatMs);
        }
      });
      ws.addEventListener("message", (event) => {
        const data = event?.data;
        void dispatch(typeof data === "string" ? data : String(data ?? "")).catch((error) => {
          report(`IM \u901A\u9053\u5904\u7406\u6D88\u606F\u51FA\u9519\uFF1A${String(error?.message ?? error)}`);
        });
      });
      ws.addEventListener("close", () => {
        if (stopped) return;
        report("\u65AD\u5F00\uFF0C\u51C6\u5907\u91CD\u8FDE");
        cleanup();
        scheduleReconnect();
      });
      ws.addEventListener("error", () => {
      });
    };
    void connect();
    return cleanup;
  });
}
var index_default = { name, inject, Config, apply };
export {
  ImReplyCollector,
  apply,
  assistantText,
  index_default as default,
  inject,
  name,
  relayMessage,
  toWsUrl
};

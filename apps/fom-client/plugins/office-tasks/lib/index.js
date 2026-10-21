// apps/fom-client/plugins/office-tasks/index.ts
import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

// apps/fom-client/plugins/office-tasks/tasks.ts
function textOf(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const item = block;
    if (item.type === "text" && typeof item.text === "string" && item.text.trim() !== "") parts.push(item.text);
  }
  return parts.join(" ").trim();
}
function taskTitle(text, limit = 80) {
  const trimmed = text.trim();
  if (trimmed === "") return void 0;
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}\u2026`;
}
function statusOf(eventType) {
  if (eventType === "turn/start") return "running";
  if (eventType === "turn/end") return "idle";
  return void 0;
}

// apps/fom-client/plugins/office-tasks/index.ts
var Config = z.object({
  /** 关掉 ⇒ 不上报也不接派活。 */
  enabled: z.boolean().default(true)
});
var name = "office-tasks";
var inject = ["officeImChannel", "agents", "agentDefaultModel"];
function apply(ctx, config) {
  if (!config.enabled) return;
  const channel = () => ctx.get("officeImChannel");
  const titles = /* @__PURE__ */ new Map();
  const taskIds = /* @__PURE__ */ new Map();
  const report = (taskId, status, title) => {
    const target = channel();
    if (target === void 0) return;
    const frame = { type: "task.report", taskId, status };
    if (title !== void 0) frame.title = title;
    target.send(frame);
  };
  ctx.effect(() => {
    const off = ctx.on("session/event", (session, event) => {
      const sessionId = String(session?.id ?? "");
      if (sessionId === "") return;
      const type = String(event?.type ?? "");
      const data = event?.data;
      if (type === "user/message" && !titles.has(sessionId)) {
        const title = taskTitle(textOf(data?.message));
        if (title !== void 0) {
          titles.set(sessionId, title);
          report(sessionId, "running", title);
        }
        return;
      }
      const status = statusOf(type);
      if (status === void 0) return;
      report(taskIds.get(sessionId) ?? sessionId, status, titles.get(sessionId));
    });
    return () => {
      off();
    };
  }, "office-tasks: \u4F1A\u8BDD\u4E8B\u4EF6 \u2192 task.report");
  ctx.effect(() => {
    const target = channel();
    if (target === void 0) return () => {
    };
    const off = target.onDownlink("task.create", (frame) => {
      void createTask(frame);
    });
    return () => {
      off();
    };
    async function createTask(frame) {
      const taskId = String(frame.taskId ?? "").trim();
      const text = String(frame.text ?? "").trim();
      if (taskId === "" || text === "") return;
      const declared = ctx;
      const agents = declared.agents ?? ctx.get("agents");
      const defaults = declared.agentDefaultModel ?? ctx.get("agentDefaultModel");
      const selection = defaults?.currentSelection?.();
      if (agents?.create === void 0 || selection === void 0) {
        report(taskId, "idle", taskTitle(text));
        return;
      }
      try {
        const sessionId = `session-${taskId}`;
        const handle = await agents.create({ sessionId, agentOptions: selection, meta: { cwd: process.cwd() } });
        taskIds.set(sessionId, taskId);
        titles.set(sessionId, taskTitle(text) ?? taskId);
        handle.agent?.followup(createUserMessage({ content: [{ type: "text", text }], source: { kind: "user" } }));
        report(taskId, "running", taskTitle(text));
      } catch {
        report(taskId, "idle", taskTitle(text));
      }
    }
  }, "office-tasks: task.create \u21D2 \u5728 PC \u5EFA\u4F1A\u8BDD");
}
var index_default = { name, inject, Config, apply };
export {
  Config,
  apply,
  index_default as default,
  inject,
  name,
  statusOf,
  taskTitle,
  textOf
};

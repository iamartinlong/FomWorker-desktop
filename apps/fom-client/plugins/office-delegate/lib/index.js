var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// apps/fom-client/plugins/office-delegate/index.ts
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import z from "@deepseek-ai/schemastery";

// apps/fom-client/plugins/office-delegate/approval-race.ts
async function raceApproval(deps, config) {
  if (!config.away) {
    const first = await Promise.race([
      deps.local.then((value) => ({ kind: "local", value })),
      deps.sleep(Math.max(0, config.forwardAfterMs)).then(() => ({ kind: "timeout" }))
    ]);
    if (first.kind === "local" && !(deps.isLocalUnavailable?.(first.value) ?? false)) return first.value;
  }
  const remote = Promise.race([
    deps.startRemote().catch(() => deps.sentFailure ?? deps.remoteTimeout ?? void 0),
    deps.sleep(Math.max(0, config.remoteTimeoutMs)).then(() => deps.remoteTimeout ?? void 0)
  ]);
  const localArm = deps.local.then(
    (value) => deps.isLocalUnavailable?.(value) === true ? new Promise(() => {
    }) : { from: "local", value }
  );
  const winner = await Promise.race([
    localArm,
    remote.then((value) => ({ from: "remote", value }))
  ]);
  if (winner.from === "local") deps.onLocalWonAfterPush?.();
  return winner.value;
}

// apps/fom-client/plugins/office-delegate/index.ts
var Config = z.object({
  /** 关掉 ⇒ 完全退回本地面板（托管不介入）。 */
  enabled: z.boolean().default(true),
  /** 本地面板无应答多久后转发（毫秒）。 */
  forwardAfterMs: z.number().default(2e4),
  /** 远程等多久不回就放弃（毫秒，缺省 10 分钟）。 */
  remoteTimeoutMs: z.number().default(6e5),
  /** idle 超过多久算「离开」（毫秒，缺省 5 分钟）⇒ 立即转发。 */
  idleForwardMs: z.number().default(3e5)
});
function awayDetector(idleForwardMs) {
  let monitor;
  try {
    const electron = __require("electron");
    monitor = electron.powerMonitor;
  } catch {
    monitor = void 0;
  }
  return () => {
    if (monitor?.getSystemIdleState !== void 0) {
      try {
        if (monitor.getSystemIdleState(Math.round(idleForwardMs / 1e3)) !== "active") return true;
      } catch {
      }
    }
    try {
      const idleSeconds = monitor?.getSystemIdleTime?.();
      return idleSeconds !== void 0 && idleSeconds * 1e3 >= idleForwardMs;
    } catch {
      return false;
    }
  };
}
function report(message) {
  const line = `${(/* @__PURE__ */ new Date()).toISOString()} [office-delegate] ${message}`;
  process.stderr.write(line + "\n");
  try {
    appendFileSync(join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "logs", "office-delegate.log"), line + "\n");
  } catch {
  }
}
var truncate = (text, length) => text.length <= length ? text : `${text.slice(0, length)}\u2026`;
var name = "office-delegate";
var inject = ["officeImChannel"];
function apply(ctx, config) {
  if (!config.enabled) {
    report("\u5DF2\u5173\u95ED\uFF08enabled=false\uFF09\u21D2 \u5B8C\u5168\u9000\u56DE\u672C\u5730\u9762\u677F");
    return;
  }
  const away = awayDetector(config.idleForwardMs);
  const channel = () => ctx.get("officeImChannel");
  const pushRemote = (req, approvalId) => {
    const target = channel();
    if (target === void 0) return Promise.resolve("unavailable");
    const answer = new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        off();
        resolve(value);
      };
      const off = target.onDownlink("approval.action", (frame) => {
        if (String(frame.approvalId) !== approvalId) return;
        const decision = String(frame.decision);
        finish(decision === "rejected" ? "rejected" : decision === "allowed-once" ? "allowed-once" : "cancelled");
      });
      req.signal?.addEventListener("abort", () => finish("cancelled"));
    });
    const summary = truncate(req.reason ?? req.displayReason?.en ?? "", 200);
    const sent = target.send({
      type: "approval.request",
      approvalId,
      toolName: req.toolName,
      summary
    });
    if (!sent) return Promise.resolve("unavailable");
    report(`\u5DF2\u8F6C\u53D1\u5230 IM\uFF08approvalId=${approvalId}\uFF0Ctool=${req.toolName}\uFF09`);
    return answer;
  };
  ctx.effect(() => {
    const off = ctx.on(
      "approval/request",
      (req, next) => {
        const local = next().catch(() => "unavailable");
        const approvalId = randomUUID();
        const isAway = away();
        if (isAway) report(`\u68C0\u6D4B\u5230\u79BB\u5F00\uFF08idle/\u9501\u5C4F\uFF09\u21D2 \u7ACB\u5373\u8F6C\u53D1\uFF08${req.toolName}\uFF09`);
        return raceApproval(
          {
            local,
            startRemote: () => pushRemote(req, approvalId),
            sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            sentFailure: "unavailable",
            isLocalUnavailable: (value) => value === "unavailable",
            remoteTimeout: "cancelled",
            onLocalWonAfterPush: () => {
              report(`\u672C\u5730\u5148\u7B54\uFF08\u8FDC\u7A0B\u4F5C\u5E9F\uFF0CapprovalId=${approvalId}\uFF09`);
              channel()?.send({ type: "approval.answered", approvalId });
            }
          },
          { forwardAfterMs: config.forwardAfterMs, remoteTimeoutMs: config.remoteTimeoutMs, away: isAway }
        );
      },
      { prepend: true }
    );
    return () => {
      off();
    };
  }, "office-delegate: \u5BA1\u6279\u6258\u7BA1\uFF08\u672C\u5730 vs IM \u7ADE\u901F\uFF09");
  report(`\u5DF2\u542F\u7528\uFF08forwardAfterMs=${config.forwardAfterMs}, remoteTimeoutMs=${config.remoteTimeoutMs}, idleForwardMs=${config.idleForwardMs}\uFF09`);
}
var index_default = { name, inject, Config, apply };
export {
  Config,
  apply,
  index_default as default,
  inject,
  name,
  raceApproval
};

// apps/fom-client/plugins/office-billing/index.ts
import z from "@deepseek-ai/schemastery";

// apps/fom-client/plugins/office-billing/pricing.ts
function n(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function resolvePrice(table, model) {
  return table.models[model] ?? table.fallback;
}
function costOf(usage, price) {
  const cacheRead = price.cacheReadPerMTok ?? price.inputPerMTok;
  const cacheWrite = price.cacheWritePerMTok ?? price.inputPerMTok;
  return (n(usage.inputTokens) * price.inputPerMTok + n(usage.cacheReadTokens) * cacheRead + n(usage.cacheWriteTokens) * cacheWrite + n(usage.outputTokens) * price.outputPerMTok) / 1e6;
}

// apps/fom-client/plugins/office-billing/quota.ts
var OVERAGE_ACTIONS = ["warn", "reject", "downgrade"];
function evaluateQuota(actual, limits, action = "warn") {
  const exceeded = [];
  if (limits.maxTokens !== void 0 && actual.tokens > limits.maxTokens) exceeded.push("tokens");
  if (limits.maxCost !== void 0 && actual.cost > limits.maxCost) exceeded.push("cost");
  if (limits.maxCalls !== void 0 && actual.calls > limits.maxCalls) exceeded.push("calls");
  return { within: exceeded.length === 0, exceeded, action };
}

// apps/fom-client/plugins/office-billing/platform.ts
var QUOTA_PATH = "/api/config/quota";
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function number(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
function limit(value) {
  const parsed = number(value);
  return parsed > 0 ? parsed : void 0;
}
function quotaFromDto(dto, fetchedAt = Date.now()) {
  const record = asRecord(dto);
  if (record === void 0) throw new Error("\u914D\u989D\u4E0B\u53D1\uFF1A\u54CD\u5E94\u4E0D\u662F\u5BF9\u8C61");
  const limits = {};
  const maxTokens = limit(record.maxTokens);
  const maxCost = limit(record.maxCost);
  const maxCalls = limit(record.maxCalls);
  return {
    period: typeof record.period === "string" ? record.period : "",
    limits: {
      ...maxTokens === void 0 ? {} : { maxTokens },
      ...maxCost === void 0 ? {} : { maxCost },
      ...maxCalls === void 0 ? {} : { maxCalls }
    },
    used: {
      tokens: number(record.usedTokens),
      cost: number(record.usedCost),
      calls: number(record.usedCalls)
    },
    fetchedAt
  };
}
async function fetchQuota(deps) {
  const doFetch = deps.fetchImpl ?? fetch;
  const base = deps.platformUrl.replace(/\/+$/u, "");
  const token = await deps.token();
  const headers = { accept: "application/json" };
  if (token !== "") headers.authorization = `Bearer ${token}`;
  const res = await doFetch(`${base}${QUOTA_PATH}`, { headers });
  if (!res.ok) throw new Error(`\u5E73\u53F0\u914D\u989D\u4E0B\u53D1\u5931\u8D25\uFF1AHTTP ${res.status}`);
  return quotaFromDto(await res.json(), deps.now?.() ?? Date.now());
}

// apps/fom-client/plugins/office-billing/index.ts
var name = "office-billing";
var priceSchema = z.object({
  inputPerMTok: z.number(),
  outputPerMTok: z.number(),
  cacheReadPerMTok: z.number(),
  cacheWritePerMTok: z.number()
});
var Config = z.object({
  currency: z.string().default("USD"),
  prices: z.dict(priceSchema).default({}),
  overageAction: z.string().default("warn"),
  platformUrl: z.string().default("http://localhost:5028")
});
var PLATFORM_TOKEN_REF = "FOM_PLATFORM_TOKEN";
var QUOTA_SYNC_ROUTE = "/api/office/quota/sync";
var QUOTA_READ_ROUTE = "/api/office/quota";
function createQuotaService(deps) {
  const action = deps.action ?? "warn";
  let latest;
  return {
    snapshot: () => latest,
    async sync() {
      const snapshot = await fetchQuota({
        platformUrl: deps.platformUrl,
        token: deps.token,
        ...deps.fetchImpl === void 0 ? {} : { fetchImpl: deps.fetchImpl }
      });
      latest = snapshot;
      return snapshot;
    },
    precheck: () => latest === void 0 ? void 0 : evaluateQuota(latest.used, latest.limits, action)
  };
}
function createBillingService(table, overage, quota) {
  return {
    cost: (model, usage) => {
      const price = resolvePrice(table, model);
      return price === void 0 ? void 0 : costOf(usage, price);
    },
    total: (items) => {
      let amount = 0;
      const unpriced = [];
      for (const item of items) {
        const price = resolvePrice(table, item.model);
        if (price === void 0) {
          if (!unpriced.includes(item.model)) unpriced.push(item.model);
          continue;
        }
        amount += costOf(item.usage, price);
      }
      return { currency: table.currency, amount, unpriced };
    },
    quota: (actual, limits) => evaluateQuota(actual, limits, overage),
    quotaSnapshot: () => quota?.snapshot(),
    syncQuota: () => quota === void 0 ? Promise.reject(new Error("office-billing: \u672A\u63A5\u5E73\u53F0\uFF08platformUrl \u672A\u914D\uFF09")) : quota.sync(),
    precheckQuota: () => quota?.precheck()
  };
}
function apply(ctx, config, deps = {}) {
  if (!OVERAGE_ACTIONS.includes(config.overageAction)) {
    throw new Error(`office-billing: overageAction \u975E\u6CD5\uFF08\u987B\u4E3A ${OVERAGE_ACTIONS.join("/")}\uFF09\uFF1A${config.overageAction}`);
  }
  const table = { currency: config.currency, models: config.prices };
  const overage = config.overageAction;
  const platformUrl = config.platformUrl.replace(/\/+$/u, "");
  const token = async () => {
    const credentials = ctx.get("credentials");
    return (await credentials?.resolve?.(PLATFORM_TOKEN_REF))?.value ?? "";
  };
  const quota = createQuotaService({
    platformUrl,
    token,
    action: overage,
    ...deps.fetchImpl === void 0 ? {} : { fetchImpl: deps.fetchImpl }
  });
  const service = createBillingService(table, overage, quota);
  ctx.effect(() => ctx.reflect.provide("officeBilling", service));
  ctx.inject(["connection"], (connCtx) => {
    connCtx.effect(() => {
      const conn = connCtx.get("connection");
      if (conn === void 0) return () => {
      };
      const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
      const disposeSync = conn.fetch.register({
        path: QUOTA_SYNC_ROUTE,
        methods: ["POST"],
        requestBody: "buffered",
        fetch: async () => {
          const current = ctx.get("officeBilling");
          if (current === void 0) return json({ ok: false, message: "officeBilling \u670D\u52A1\u7F3A\u5931" }, 500);
          try {
            const snapshot = await current.syncQuota();
            return json({ ok: true, ...snapshot });
          } catch (error) {
            return json({ ok: false, message: String(error?.message ?? error) });
          }
        }
      });
      const disposeRead = conn.fetch.register({
        path: QUOTA_READ_ROUTE,
        methods: ["GET"],
        requestBody: "buffered",
        fetch: async () => {
          const current = ctx.get("officeBilling");
          if (current === void 0) return json({ ok: false, message: "officeBilling \u670D\u52A1\u7F3A\u5931" }, 500);
          return json({ ok: true, snapshot: current.quotaSnapshot() ?? null, verdict: current.precheckQuota() ?? null });
        }
      });
      return () => {
        void disposeRead();
        void disposeSync();
      };
    }, "office-billing: \u914D\u989D\u8DEF\u7531\uFF08\u540C\u6B65 / \u8BFB\uFF09");
  });
}
var index_default = { name, Config, apply };
export {
  Config,
  OVERAGE_ACTIONS,
  PLATFORM_TOKEN_REF,
  QUOTA_PATH,
  QUOTA_READ_ROUTE,
  QUOTA_SYNC_ROUTE,
  apply,
  costOf,
  createBillingService,
  createQuotaService,
  index_default as default,
  evaluateQuota,
  fetchQuota,
  name,
  quotaFromDto,
  resolvePrice
};

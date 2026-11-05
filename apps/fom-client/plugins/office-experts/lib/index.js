// apps/fom-client/plugins/office-experts/index.ts
import { homedir } from "node:os";
import { join as join2 } from "node:path";

// apps/fom-client/plugins/office-experts/base.ts
var OFFICE_PERSONA_PREFIX = "\u4F60\u662F FomWorker \u529E\u516C\u52A9\u7406\uFF0C\u5E2E\u52A9\u5458\u5DE5\u5B8C\u6210\u65E5\u5E38\u529E\u516C\u4EFB\u52A1\uFF1A\u6587\u6863\u4E0E\u8868\u683C\u3001\u4F1A\u8BAE\u7EAA\u8981\u3001\u4FE1\u606F\u68C0\u7D22\u3001\u65E5\u7A0B\u4E0E\u5F85\u529E\u3001\u4EA4\u4ED8\u7269\u751F\u6210\u7B49\u3002";
var OFFICE_PERSONA_SUFFIX = "\u5F53\u524D\u5DE5\u4F5C\u76EE\u5F55\uFF1A{{cwd}}\u3002";
var OFFICE_BASE = Object.freeze([
  { id: "persona", name: "@deepseek-ai/dsh-persona", config: { prefix: OFFICE_PERSONA_PREFIX, suffix: OFFICE_PERSONA_SUFFIX } },
  { id: "agent-instructions", name: "@deepseek-ai/dsh-agent-instructions", config: { maxBytes: 65536 } },
  { id: "time-context", name: "@deepseek-ai/dsh-time-context" },
  { id: "tool-fs", name: "@deepseek-ai/dsh-tool-fs" },
  { id: "tool-fs-search", name: "@deepseek-ai/dsh-tool-fs-search", config: { sampleOverCapGlobResults: false } },
  { id: "tool-todo", name: "@deepseek-ai/dsh-tool-todo", config: { allowParallelInProgress: true } },
  { id: "tool-web", name: "@deepseek-ai/dsh-tool-web", config: { fetch: true, searchTimeoutMs: 6e4 } },
  { id: "tool-ask-user", name: "@deepseek-ai/dsh-tool-ask-user" },
  { id: "tool-skill", name: "@deepseek-ai/dsh-tool-skill" },
  { id: "skill-filesystem", name: "@deepseek-ai/dsh-skill-filesystem" },
  // 办公技能 provider（C4b）：专家组合挂它 ⇒ 覆盖全局同名 provider、**只带选中技能**（delta.skills）。
  { id: "office-skills", name: "@office/skills", config: {} },
  { id: "tool-schedule", name: "@deepseek-ai/dsh-tool-schedule" },
  { id: "present", name: "@deepseek-ai/dsh-tool-present" },
  {
    id: "compaction",
    name: "cordis:group",
    group: true,
    isolate: { compaction: true, toolResultPruner: true },
    config: [
      { id: "compaction-basic", name: "@deepseek-ai/dsh-compaction-basic" },
      { id: "command-compact", name: "@deepseek-ai/dsh-command-compact" },
      { id: "tool-result-pruner", name: "@deepseek-ai/dsh-compaction-tool-result-pruner", config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 } }
    ]
  },
  // —— 高级能力（默认关；专家可勾选开启）——
  // ⚠️ 内核要求 `plan-mode` / `tool-subagent` 落在**带 isolate 的组**里（真进程实测：平铺会
  // `Preset services require isolate realms: planMode`）⇒ 照内核 `standard` 用 `cordis:group` + `isolate` 包一层。
  {
    id: "plan-mode",
    name: "cordis:group",
    group: true,
    isolate: { planMode: true },
    disabled: true,
    config: [
      {
        id: "plan-mode-plugin",
        name: "@deepseek-ai/dsh-plan-mode",
        config: {
          section: "You are in plan mode. Explore first with non-mutating reads, then submit a decision-complete plan through exit_plan_mode. Do not edit or write files until the plan is approved."
        }
      }
    ]
  },
  {
    id: "tool-subagent",
    name: "cordis:group",
    group: true,
    isolate: { workflowEngine: true },
    disabled: true,
    config: [
      {
        id: "tool-subagent-plugin",
        name: "@deepseek-ai/dsh-tool-subagent",
        config: { provider: "spawn", toolName: "subagent", modelSelectionSettings: true, backgroundMode: "continuable" }
      }
    ]
  }
]);
var ADVANCED_ROW_IDS = Object.freeze(["tool-subagent", "plan-mode"]);

// apps/fom-client/plugins/office-experts/compose.ts
function cloneRow(row) {
  return {
    ...row.id === void 0 ? {} : { id: row.id },
    name: row.name,
    ...row.config === void 0 ? {} : { config: structuredClone(row.config) },
    ...row.disabled === void 0 ? {} : { disabled: row.disabled },
    ...row.group === void 0 ? {} : { group: row.group },
    ...row.isolate === void 0 ? {} : { isolate: { ...row.isolate } }
  };
}
function composeExpertRows(delta) {
  const rows = OFFICE_BASE.map(cloneRow);
  const byId = /* @__PURE__ */ new Map();
  for (const row of rows) if (row.id !== void 0) byId.set(row.id, row);
  if (delta.persona.prefix !== void 0 || delta.persona.suffix !== void 0) {
    const persona = byId.get("persona");
    if (persona !== void 0) {
      const config = persona.config ?? {};
      persona.config = { ...config, ...delta.persona };
    }
  }
  for (const id of delta.tools.enable ?? []) {
    const row = byId.get(id);
    if (row !== void 0) row.disabled = false;
  }
  for (const id of delta.tools.disable ?? []) {
    const row = byId.get(id);
    if (row !== void 0) row.disabled = true;
  }
  const skillsRow = byId.get("office-skills");
  if (skillsRow !== void 0 && delta.skills !== void 0) {
    skillsRow.config = { ...skillsRow.config ?? {}, skills: delta.skills };
  }
  return rows;
}
function composeExpert(delta) {
  return {
    id: delta.id,
    name: delta.name,
    description: delta.description,
    ...delta.order === void 0 ? {} : { order: delta.order },
    plugins: composeExpertRows(delta)
  };
}

// apps/fom-client/plugins/office-experts/delta.ts
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
var EXPERT_PRESETS_DIR = "presets";
function isValidExpertId(id) {
  return /^[a-z0-9][a-z0-9._-]*$/u.test(id);
}
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function strArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : void 0;
}
function parseExpertDelta(value) {
  const problems = [];
  const r = asRecord(value);
  if (r === void 0) return { problems: ["delta \u4E0D\u662F\u5BF9\u8C61"] };
  const id = typeof r.id === "string" ? r.id : "";
  const name2 = typeof r.name === "string" ? r.name : "";
  if (!isValidExpertId(id)) problems.push(`id \u975E\u6CD5\uFF1A${JSON.stringify(r.id)}`);
  if (name2 === "") problems.push("\u7F3A name");
  if (problems.length > 0) return { problems };
  const persona = asRecord(r.persona) ?? {};
  const tools = asRecord(r.tools) ?? {};
  return {
    problems,
    delta: {
      id,
      name: name2,
      description: typeof r.description === "string" ? r.description : "",
      ...typeof r.order === "number" ? { order: r.order } : {},
      persona: {
        ...typeof persona.prefix === "string" ? { prefix: persona.prefix } : {},
        ...typeof persona.suffix === "string" ? { suffix: persona.suffix } : {}
      },
      tools: {
        ...strArray(tools.enable) === void 0 ? {} : { enable: strArray(tools.enable) },
        ...strArray(tools.disable) === void 0 ? {} : { disable: strArray(tools.disable) }
      },
      ...strArray(r.skills) === void 0 ? {} : { skills: strArray(r.skills) }
    }
  };
}
function listExpertDeltas(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name.slice(0, -".json".length)).filter(isValidExpertId).sort();
  } catch {
    return [];
  }
}
function readExpertDelta(dir, id) {
  try {
    return parseExpertDelta(JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8"))).delta;
  } catch {
    return void 0;
  }
}
function writeExpertDelta(dir, delta) {
  if (!isValidExpertId(delta.id)) throw new Error(`\u975E\u6CD5\u4E13\u5BB6 id\uFF1A${delta.id}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${delta.id}.json`);
  writeFileSync(path, `${JSON.stringify(delta, void 0, 2)}
`);
  return path;
}
function removeExpertDelta(dir, id) {
  if (!isValidExpertId(id)) return false;
  const path = join(dir, `${id}.json`);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

// apps/fom-client/plugins/office-experts/tool.ts
import { defineTool } from "@deepseek-ai/dsh-tools";
function csv(value) {
  if (value === void 0) return void 0;
  const items = value.split(",").map((item) => item.trim()).filter((item) => item !== "");
  return items.length === 0 ? void 0 : items;
}
function createExpertTools(port) {
  const create = defineTool({
    name: "expert_create",
    description: "\u521B\u5EFA\u4E00\u4E2A\u300C\u4E13\u5BB6\u300D\uFF08\u53EF\u53EC\u5524\u7684 agent preset\uFF09\uFF1A\u4EBA\u8BBE + \u80FD\u529B\u52FE\u9009\u3002\u7528\u5B83\u628A\u7528\u6237\u63CF\u8FF0\u7684\u5C97\u4F4D/\u89D2\u8272/\u5DE5\u4F5C\u65B9\u6CD5\u6C89\u6DC0\u6210\u4E00\u4E2A\u4E13\u5BB6\u3002\u521B\u5EFA\u524D\u5148\u95EE\u6E05\uFF1A\u540D\u79F0\u3001\u4EBA\u8BBE\uFF08\u662F\u8C01 + \u4EC0\u4E48\u80CC\u666F + \u64C5\u957F\u4EC0\u4E48\uFF09\u3001\u8981\u4E0D\u8981\u5F00\u9AD8\u7EA7\u80FD\u529B\uFF08plan-mode / tool-subagent\uFF09\u3002\u4E13\u5BB6\u4E0D\u7ED1\u6A21\u578B\uFF08\u6A21\u578B\u5728\u5BF9\u8BDD\u6846\u91CC\u9009\uFF09\u3002",
    parameters: {
      id: { type: "string", required: true, description: "\u4E13\u5BB6\u6807\u8BC6\uFF1A\u5C0F\u5199\u5B57\u6BCD\u6570\u5B57\u4E0E `.` `_` `-`\uFF0C\u4F5C\u6587\u4EF6\u540D\uFF0C\u5982 `contract-review`\u3002" },
      name: { type: "string", required: true, description: "\u5C55\u793A\u540D\uFF0C\u5982\u300C\u5408\u540C\u5BA1\u9605\u5B98\u300D\u3002" },
      description: { type: "string", description: "\u4E00\u53E5\u8BDD\u8BF4\u660E\u3002" },
      personaPrefix: { type: "string", description: "\u4EBA\u8BBE\u524D\u7F00\uFF1A\u662F\u8C01 + \u6709\u4EC0\u4E48\u80CC\u666F\uFF08\u4E0D\u8981\u5199\u6210\u4EFB\u52A1\u672C\u8EAB\uFF09\u3002" },
      personaSuffix: { type: "string", description: "\u4EBA\u8BBE\u540E\u7F00\uFF1A\u8865\u5145\u7EA6\u675F\uFF08\u5982\u300C\u4E0D\u786E\u5B9A\u65F6\u5148\u95EE\uFF0C\u4E0D\u8981\u81C6\u6D4B\u300D\uFF09\u3002" },
      tools: { type: "string", description: "\u8981\u5F00\u542F\u7684**\u9AD8\u7EA7\u80FD\u529B**\uFF0C\u9017\u53F7\u5206\u9694\uFF08\u53EF\u9009 `plan-mode`\u3001`tool-subagent`\uFF09\u3002" },
      skills: { type: "string", description: "\u8981\u5E26\u7684\u6280\u80FD\u540D\uFF0C\u9017\u53F7\u5206\u9694\uFF08\u53EF\u9009\uFF09\u3002" }
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", required: true },
          path: { type: "string", required: true }
        }
      },
      render: (_args, value) => [{ type: "text", text: `\u5DF2\u521B\u5EFA\u4E13\u5BB6 ${value.id}\uFF08${value.path}\uFF09` }]
    },
    async execute(args) {
      const enabledTools = csv(args.tools);
      const skills = csv(args.skills);
      const delta = {
        id: args.id,
        name: args.name,
        description: args.description ?? "",
        persona: {
          ...args.personaPrefix === void 0 || args.personaPrefix === "" ? {} : { prefix: args.personaPrefix },
          ...args.personaSuffix === void 0 || args.personaSuffix === "" ? {} : { suffix: args.personaSuffix }
        },
        tools: { ...enabledTools === void 0 ? {} : { enable: enabledTools } },
        ...skills === void 0 ? {} : { skills }
      };
      const result = await port.create(delta);
      return { id: result.id, path: result.path };
    }
  });
  return { create };
}

// apps/fom-client/plugins/office-experts/index.ts
var name = "office-experts";
var inject = ["agentPresets", "tools"];
function resolveDshHome() {
  const home = process.env.DSH_HOME;
  return home !== void 0 && home !== "" ? home : join2(homedir(), ".dsh");
}
function expertPresetsDir(home = resolveDshHome()) {
  return join2(home, "office", EXPERT_PRESETS_DIR);
}
function loadExpertDefinitions(dir) {
  const definitions = [];
  for (const id of listExpertDeltas(dir)) {
    const delta = readExpertDelta(dir, id);
    if (delta !== void 0) definitions.push(composeExpert(delta));
  }
  return definitions;
}
function apply(ctx) {
  const presets = ctx.get("agentPresets");
  if (presets === void 0) throw new Error("office-experts: agentPresets \u670D\u52A1\u7F3A\u5931");
  const tools = ctx.get("tools");
  if (tools === void 0) throw new Error("office-experts: tools \u670D\u52A1\u7F3A\u5931");
  const dir = expertPresetsDir();
  const disposers = /* @__PURE__ */ new Map();
  const create = async (delta) => {
    const path = writeExpertDelta(dir, delta);
    const dispose = await presets.register(composeExpert(delta));
    disposers.set(delta.id, dispose);
    return path;
  };
  const remove = (id) => {
    const removed = removeExpertDelta(dir, id);
    const dispose = disposers.get(id);
    if (dispose !== void 0) {
      disposers.delete(id);
      void dispose();
    }
    return removed;
  };
  ctx.effect(() => {
    const registrations = loadExpertDefinitions(dir).map((definition) => presets.register(definition));
    return () => {
      void Promise.allSettled(registrations).then((results) => Promise.allSettled(
        results.map((result) => result.status === "fulfilled" ? result.value() : Promise.resolve())
      ));
    };
  });
  ctx.effect(() => {
    const expertTools = createExpertTools({ create: async (delta) => ({ id: delta.id, path: await create(delta) }) });
    return tools.register(expertTools.create);
  });
  ctx.effect(() => ctx.reflect.provide("officeExperts", { create, remove }));
}
var index_default = { name, inject, apply };
export {
  ADVANCED_ROW_IDS,
  EXPERT_PRESETS_DIR,
  OFFICE_BASE,
  OFFICE_PERSONA_PREFIX,
  OFFICE_PERSONA_SUFFIX,
  apply,
  composeExpert,
  composeExpertRows,
  createExpertTools,
  index_default as default,
  expertPresetsDir,
  inject,
  isValidExpertId,
  listExpertDeltas,
  loadExpertDefinitions,
  name,
  parseExpertDelta,
  readExpertDelta,
  removeExpertDelta,
  resolveDshHome,
  writeExpertDelta
};

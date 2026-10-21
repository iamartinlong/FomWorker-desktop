// apps/fom-client/plugins/office-catalog/index.ts
import { homedir } from "node:os";
import { join as join3 } from "node:path";

// apps/fom-client/plugins/office-catalog/catalog.ts
var CATALOG_KINDS = ["skill", "expert", "connector"];
var CATALOG_VERSION = "0.1.0";
function freezeEntry(entry) {
  Object.freeze(entry.source);
  Object.freeze(entry.tags);
  return Object.freeze(entry);
}
function platformEntry(entry) {
  return freezeEntry({ ...entry, origin: "platform" });
}
var DEFAULT_CATALOG = Object.freeze([
  // —— 技能：来自 office-skills（自研）——
  platformEntry({
    id: "skill:meeting-minutes",
    kind: "skill",
    name: "\u4F1A\u8BAE\u7EAA\u8981\u5206\u53D1",
    description: "\u628A\u4F1A\u8BAE\u8BB0\u5F55/\u8F6C\u5F55\u6574\u7406\u6210\u7ED3\u6784\u5316\u7EAA\u8981\uFF08\u7ED3\u8BBA + \u5F85\u529E\u542B\u8D1F\u8D23\u4EBA\u4E0E\u671F\u9650\uFF09\uFF0C\u53EF\u53D1\u5E03\u4E3A\u98DE\u4E66\u4E91\u6587\u6863\u3002",
    version: "1.0.0",
    category: "\u529E\u516C\u534F\u4F5C",
    defaultEnabled: true,
    source: { kind: "skill-provider", ref: "office-skills:meeting-minutes" },
    tags: ["\u4F1A\u8BAE", "\u7EAA\u8981", "\u98DE\u4E66"]
  }),
  platformEntry({
    id: "skill:weekly-report",
    kind: "skill",
    name: "\u5468\u62A5\u6C47\u603B",
    description: "\u6C47\u603B\u4E00\u5468\u6570\u636E\uFF08\u591A\u7EF4\u8868\u683C / \u65E5\u5386 / \u5DE5\u4F5C\u533A\u6587\u4EF6\uFF09\u751F\u6210\u7ED3\u6784\u5316\u5468\u62A5\uFF0C\u53EF\u53D1\u5E03\u4E3A\u98DE\u4E66\u4E91\u6587\u6863\u3002",
    version: "1.0.0",
    category: "\u529E\u516C\u534F\u4F5C",
    defaultEnabled: true,
    source: { kind: "skill-provider", ref: "office-skills:weekly-report" },
    tags: ["\u5468\u62A5", "\u6C47\u603B"]
  }),
  // —— 技能：来自内核 skill-office（随平台默认挂载）——
  platformEntry({
    id: "skill:office-docx",
    kind: "skill",
    name: "Word \u6587\u6863",
    description: "\u751F\u6210\u4E0E\u68C0\u67E5 .docx\uFF08\u542B OOXML \u7ED3\u6784\u68C0\u67E5\uFF09\u3002",
    version: "0.2.1-alpha.1",
    category: "\u6587\u6863",
    defaultEnabled: true,
    source: { kind: "bundle", ref: "@deepseek-ai/dsh-skill-office" },
    tags: ["docx", "office"]
  }),
  platformEntry({
    id: "skill:office-pptx",
    kind: "skill",
    name: "\u5E7B\u706F\u7247",
    description: "\u751F\u6210\u4E0E\u68C0\u67E5 .pptx\u3002",
    version: "0.2.1-alpha.1",
    category: "\u6587\u6863",
    defaultEnabled: true,
    source: { kind: "bundle", ref: "@deepseek-ai/dsh-skill-office" },
    tags: ["pptx", "office"]
  }),
  platformEntry({
    id: "skill:office-xlsx",
    kind: "skill",
    name: "\u8868\u683C",
    description: "\u751F\u6210\u4E0E\u68C0\u67E5 .xlsx\u3002",
    version: "0.2.1-alpha.1",
    category: "\u6587\u6863",
    defaultEnabled: true,
    source: { kind: "bundle", ref: "@deepseek-ai/dsh-skill-office" },
    tags: ["xlsx", "office"]
  }),
  // —— 连接器：来自 office-feishu（自研）——
  platformEntry({
    id: "connector:feishu",
    kind: "connector",
    name: "\u98DE\u4E66",
    description: "\u63A5\u5165\u98DE\u4E66\uFF1A\u4E91\u6587\u6863\u8BFB\u5199\u3001\u591A\u7EF4\u8868\u683C\u3001\u65E5\u5386\uFF0C\u4EE5\u53CA\u5BA1\u6279\u5361\u7247\u6536\u53D1\u3002",
    version: "1.0.0",
    category: "\u63A5\u5165",
    defaultEnabled: true,
    source: { kind: "bundle", ref: "office-feishu" },
    tags: ["IM", "\u98DE\u4E66", "\u5BA1\u6279"]
  }),
  // —— 专家：内核默认 agent 预设（平台默认专家）——
  platformEntry({
    id: "expert:standard",
    kind: "expert",
    name: "\u901A\u7528\u529E\u516C\u52A9\u624B",
    description: "\u9ED8\u8BA4\u4E13\u5BB6\uFF1A\u9762\u5411\u65E5\u5E38\u529E\u516C\u573A\u666F\u7684\u901A\u7528 agent \u7EC4\u5408\u3002",
    version: "0.2.1-alpha.1",
    category: "\u4E13\u5BB6",
    defaultEnabled: true,
    source: { kind: "agent-preset", ref: "standard" },
    tags: ["\u9ED8\u8BA4"]
  }),
  // —— 专家：业务域专家（PSI / PBM / PSP）——
  platformEntry({
    id: "expert:psi",
    kind: "expert",
    name: "\u6570\u636E\u5206\u6790\u4E0E\u667A\u80FD PSI",
    description: "\u6570\u636E\u5206\u6790\u3001\u5E02\u573A\u6570\u636E\u5206\u6790\uFF1B\u9500\u552E\u8D8B\u52BF\u9884\u6D4B\u3001\u51B3\u7B56\u7BA1\u7406\u3002",
    version: "1.0.0",
    category: "\u6570\u636E\u5206\u6790",
    defaultEnabled: true,
    source: { kind: "agent-preset", ref: "psi" },
    tags: ["\u6570\u636E\u5206\u6790", "\u9884\u6D4B", "\u51B3\u7B56"]
  }),
  platformEntry({
    id: "expert:pbm",
    kind: "expert",
    name: "\u79FB\u52A8\u5316\u7BA1\u7406 PBM",
    description: "\u79FB\u52A8\u6570\u636E\u67E5\u8BE2\u3001\u79FB\u52A8\u6570\u636E\u4EA4\u4E92\uFF1B\u5FAE\u4FE1\u5E73\u53F0\u5E94\u7528\u3001APP \u5E94\u7528\u3001\u667A\u6167\u5E94\u7528\u3001\u4E07\u7269\u4E92\u8054\u3002",
    version: "1.0.0",
    category: "\u79FB\u52A8\u5316",
    defaultEnabled: true,
    source: { kind: "agent-preset", ref: "pbm" },
    tags: ["\u79FB\u52A8", "\u5FAE\u4FE1", "APP", "\u7269\u8054\u7F51"]
  }),
  platformEntry({
    id: "expert:psp",
    kind: "expert",
    name: "\u6D41\u7A0B\u4E0E\u4E1A\u52A1\u7BA1\u7406 PSP",
    description: "\u5185\u90E8\u9500\u552E\u4E1A\u52A1\u7BA1\u7406\uFF08\u4E3B\u6570\u636E\u3001\u8D39\u7528\u63A7\u5236\u3001\u6307\u6807\u3001\u5956\u91D1\u3001\u9884\u6D4B\u7B49\uFF09\uFF1B\u9500\u552E\u884C\u4E3A\u7BA1\u7406\uFF08CRM\u3001\u62DC\u8BBF\u7BA1\u7406\u3001\u6E20\u9053\u7BA1\u7406\u7B49\uFF09\u3002",
    version: "1.0.0",
    category: "\u6D41\u7A0B\u7BA1\u7406",
    defaultEnabled: true,
    source: { kind: "agent-preset", ref: "psp" },
    tags: ["CRM", "\u9500\u552E", "\u6D41\u7A0B"]
  })
]);
function validateCatalog(entries) {
  const problems = [];
  const seen = /* @__PURE__ */ new Set();
  for (const entry of entries) {
    if (entry.id === "") problems.push(`\u6761\u76EE\u7F3A\u5C11 id\uFF08name=${entry.name}\uFF09`);
    if (!entry.id.startsWith(`${entry.kind}:`)) {
      problems.push(`id \u524D\u7F00\u4E0E kind \u4E0D\u7B26\uFF1A${entry.id} / ${entry.kind}\uFF08\u5E94\u4E3A ${entry.kind}:\u2026\uFF09`);
    }
    if (seen.has(entry.id)) problems.push(`id \u91CD\u590D\uFF1A${entry.id}`);
    seen.add(entry.id);
    if (entry.name === "") problems.push(`\u6761\u76EE\u7F3A\u5C11 name\uFF1A${entry.id}`);
    if (entry.description === "") problems.push(`\u6761\u76EE\u7F3A\u5C11 description\uFF1A${entry.id}`);
    if (entry.version === "") problems.push(`\u6761\u76EE\u7F3A\u5C11 version\uFF1A${entry.id}`);
    if (entry.category === "") problems.push(`\u6761\u76EE\u7F3A\u5C11 category\uFF1A${entry.id}`);
    if (entry.source.ref === "") problems.push(`\u6761\u76EE\u7F3A\u5C11 source.ref\uFF1A${entry.id}`);
    if (entry.origin !== "platform" && entry.origin !== "local") problems.push(`\u672A\u77E5 origin\uFF1A${String(entry.origin)}\uFF08${entry.id}\uFF09`);
    if (!CATALOG_KINDS.includes(entry.kind)) problems.push(`\u672A\u77E5 kind\uFF1A${entry.kind}\uFF08${entry.id}\uFF09`);
  }
  return problems;
}
function mergeCatalog(platform, local) {
  const localIds = new Set(local.map((entry) => entry.id));
  return [...platform.filter((entry) => !localIds.has(entry.id)), ...local];
}
function createCatalogService(platform = DEFAULT_CATALOG, local = []) {
  const localEntries = () => typeof local === "function" ? local() : local;
  return {
    version: CATALOG_VERSION,
    list(kind) {
      const all = mergeCatalog(platform, localEntries());
      return kind === void 0 ? all : all.filter((entry) => entry.kind === kind);
    },
    get(id) {
      return mergeCatalog(platform, localEntries()).find((entry) => entry.id === id);
    },
    validate() {
      return validateCatalog(mergeCatalog(platform, localEntries()));
    }
  };
}

// apps/fom-client/plugins/office-catalog/local-catalog.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
var LOCAL_CATALOG_FILE = "catalog.local.json";
var LOCAL_CATALOG_SCHEMA = 1;
var SOURCE_KINDS = ["bundle", "skill-provider", "mcp", "agent-preset"];
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function str(value) {
  return typeof value === "string" ? value : void 0;
}
function parseEntry(value) {
  const r = asRecord(value);
  if (r === void 0) return "\u975E\u5BF9\u8C61";
  const id = str(r.id);
  const kind = str(r.kind);
  const name2 = str(r.name);
  if (id === void 0 || id === "") return "\u7F3A id";
  if (kind === void 0 || !CATALOG_KINDS.includes(kind)) return `kind \u975E\u6CD5\uFF1A${String(r.kind)}`;
  if (!id.startsWith(`${kind}:`)) return `id \u524D\u7F00\u4E0E kind \u4E0D\u7B26\uFF1A${id}`;
  if (name2 === void 0 || name2 === "") return "\u7F3A name";
  const source = asRecord(r.source);
  const sourceKind = str(source?.kind);
  const tags = Array.isArray(r.tags) ? r.tags.filter((t) => typeof t === "string") : [];
  return {
    id,
    kind,
    name: name2,
    description: str(r.description) ?? "",
    version: str(r.version) ?? "0.0.0",
    category: str(r.category) ?? "\u672C\u5730",
    origin: "local",
    defaultEnabled: r.defaultEnabled === true,
    source: {
      kind: sourceKind !== void 0 && SOURCE_KINDS.includes(sourceKind) ? sourceKind : "bundle",
      ref: str(source?.ref) ?? id
    },
    tags
  };
}
function parseLocalCatalog(value) {
  const problems = [];
  const entries = [];
  const root = asRecord(value);
  if (root === void 0) return { entries, problems: ["\u672C\u5730\u76EE\u5F55\u4E0D\u662F\u5BF9\u8C61"] };
  if (root.schemaVersion !== LOCAL_CATALOG_SCHEMA) problems.push(`\u672C\u5730\u76EE\u5F55 schemaVersion \u975E ${LOCAL_CATALOG_SCHEMA}\uFF08\u5FFD\u7565\uFF09`);
  const raw = root.entries;
  if (!Array.isArray(raw)) return { entries, problems: [...problems, "\u672C\u5730\u76EE\u5F55 entries \u975E\u6570\u7EC4"] };
  for (const [index, item] of raw.entries()) {
    const parsed = parseEntry(item);
    if (typeof parsed === "string") problems.push(`\u7B2C ${index} \u6761\uFF1A${parsed}`);
    else entries.push(parsed);
  }
  return { entries, problems };
}
function readLocalCatalog(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  try {
    return parseLocalCatalog(JSON.parse(text)).entries;
  } catch {
    return [];
  }
}
function writeLocalCatalog(path, entries) {
  mkdirSync(dirname(path), { recursive: true });
  const body = entries.map((entry) => ({ ...entry, origin: "local" }));
  writeFileSync(path, `${JSON.stringify({ schemaVersion: LOCAL_CATALOG_SCHEMA, entries: body }, void 0, 2)}
`);
}

// apps/fom-client/plugins/office-skills/managed.ts
import { existsSync, mkdirSync as mkdirSync2, readFileSync as readFileSync2, readdirSync, rmSync, writeFileSync as writeFileSync2 } from "node:fs";
import { join } from "node:path";
var MANAGED_SKILLS_DIR = "skills";
function parseSkillFrontmatter(raw) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(raw);
  if (match === null) return {};
  const out = {};
  for (const line of match[1].split(/\r?\n/u)) {
    const m = /^(name|description):\s*(.*)$/u.exec(line.trim());
    if (m !== null) out[m[1]] = m[2].trim();
  }
  return out;
}
function listManagedSkills(root) {
  try {
    return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "SKILL.md"))).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}
function readManagedSkill(root, slug) {
  try {
    return readFileSync2(join(root, slug, "SKILL.md"), "utf8");
  } catch {
    return void 0;
  }
}

// apps/fom-client/plugins/office-skills/platform.ts
var PLATFORM_SKILLS_DIR = "platform-skills";

// apps/fom-client/plugins/office-experts/delta.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync3, readFileSync as readFileSync3, readdirSync as readdirSync2, rmSync as rmSync2, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join2 } from "node:path";
var EXPERT_PRESETS_DIR = "presets";
function isValidExpertId(id) {
  return /^[a-z0-9][a-z0-9._-]*$/u.test(id);
}
function asRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function strArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : void 0;
}
function parseExpertDelta(value) {
  const problems = [];
  const r = asRecord2(value);
  if (r === void 0) return { problems: ["delta \u4E0D\u662F\u5BF9\u8C61"] };
  const id = typeof r.id === "string" ? r.id : "";
  const name2 = typeof r.name === "string" ? r.name : "";
  if (!isValidExpertId(id)) problems.push(`id \u975E\u6CD5\uFF1A${JSON.stringify(r.id)}`);
  if (name2 === "") problems.push("\u7F3A name");
  if (problems.length > 0) return { problems };
  const persona = asRecord2(r.persona) ?? {};
  const tools = asRecord2(r.tools) ?? {};
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
    return readdirSync2(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map((entry) => entry.name.slice(0, -".json".length)).filter(isValidExpertId).sort();
  } catch {
    return [];
  }
}
function readExpertDelta(dir, id) {
  try {
    return parseExpertDelta(JSON.parse(readFileSync3(join2(dir, `${id}.json`), "utf8"))).delta;
  } catch {
    return void 0;
  }
}

// apps/fom-client/plugins/office-catalog/index.ts
var name = "office-catalog";
function resolveDshHome() {
  const home = process.env.DSH_HOME;
  return home !== void 0 && home !== "" ? home : join3(homedir(), ".dsh");
}
function localCatalogPath(home = resolveDshHome()) {
  return join3(home, "office", LOCAL_CATALOG_FILE);
}
function managedSkillsRoot(home = resolveDshHome()) {
  return join3(home, "office", MANAGED_SKILLS_DIR);
}
function managedSkillEntries(root) {
  return listManagedSkills(root).map((slug) => {
    const raw = readManagedSkill(root, slug) ?? "";
    const meta = parseSkillFrontmatter(raw);
    return {
      id: `skill:${slug}`,
      kind: "skill",
      name: meta.name ?? slug,
      description: meta.description ?? "",
      version: "0.1.0",
      category: "\u81EA\u5EFA",
      origin: "local",
      defaultEnabled: true,
      source: { kind: "skill-provider", ref: `office-skills:${slug}` },
      tags: []
    };
  });
}
function platformSkillsRoot(home = resolveDshHome()) {
  return join3(home, "office", PLATFORM_SKILLS_DIR);
}
function platformSkillEntries(root) {
  return listManagedSkills(root).map((slug) => {
    const raw = readManagedSkill(root, slug) ?? "";
    const meta = parseSkillFrontmatter(raw);
    return {
      id: `skill:${slug}`,
      kind: "skill",
      name: meta.name ?? slug,
      description: meta.description ?? "",
      version: "0.1.0",
      category: "\u5E73\u53F0\u4E0B\u53D1",
      origin: "platform",
      defaultEnabled: true,
      source: { kind: "skill-provider", ref: `office-skills:${slug}` },
      tags: []
    };
  });
}
function expertDeltasRoot(home = resolveDshHome()) {
  return join3(home, "office", EXPERT_PRESETS_DIR);
}
function expertEntries(root) {
  return listExpertDeltas(root).map((id) => {
    const delta = readExpertDelta(root, id);
    return {
      id: `expert:${id}`,
      kind: "expert",
      name: delta?.name ?? id,
      description: delta?.description ?? "",
      version: "0.1.0",
      category: "\u81EA\u5EFA",
      origin: "local",
      defaultEnabled: true,
      source: { kind: "agent-preset", ref: id },
      tags: []
    };
  });
}
function apply(ctx) {
  ctx.effect(() => ctx.reflect.provide("officeCatalog", createCatalogService(DEFAULT_CATALOG, () => [
    ...managedSkillEntries(managedSkillsRoot()),
    ...platformSkillEntries(platformSkillsRoot()),
    ...expertEntries(expertDeltasRoot()),
    ...readLocalCatalog(localCatalogPath())
  ])));
}
var index_default = { name, apply };
export {
  CATALOG_KINDS,
  CATALOG_VERSION,
  DEFAULT_CATALOG,
  LOCAL_CATALOG_FILE,
  LOCAL_CATALOG_SCHEMA,
  apply,
  createCatalogService,
  index_default as default,
  expertDeltasRoot,
  expertEntries,
  localCatalogPath,
  managedSkillEntries,
  managedSkillsRoot,
  mergeCatalog,
  name,
  parseLocalCatalog,
  platformSkillEntries,
  platformSkillsRoot,
  readLocalCatalog,
  resolveDshHome,
  validateCatalog,
  writeLocalCatalog
};

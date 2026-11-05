// apps/fom-client/plugins/office-skills/index.ts
import { existsSync as existsSync3, readdirSync as readdirSync2, readFileSync as readFileSync3, unwatchFile, watch, watchFile } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join as join3, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";
import { BUNDLED_SKILL_RANK } from "@deepseek-ai/dsh-skill";

// apps/fom-client/plugins/office-skills/managed.ts
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
var MANAGED_SKILLS_DIR = "skills";
function isValidSkillSlug(slug) {
  return /^[a-z0-9][a-z0-9._-]*$/u.test(slug);
}
function renderSkillMarkdown(spec) {
  return `---
name: ${spec.name}
description: ${spec.description}
---

${spec.body.trim()}
`;
}
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
function skillBody(raw) {
  const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u.exec(raw);
  return (match === null ? raw : raw.slice(match[0].length)).trim();
}
function writeManagedSkill(root, spec) {
  if (!isValidSkillSlug(spec.slug)) throw new Error(`\u975E\u6CD5\u6280\u80FD slug\uFF1A${spec.slug}`);
  const directory = join(root, spec.slug);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, "SKILL.md");
  writeFileSync(path, renderSkillMarkdown(spec));
  return path;
}
function removeManagedSkill(root, slug) {
  if (!isValidSkillSlug(slug)) return false;
  const directory = join(root, slug);
  if (!existsSync(directory)) return false;
  rmSync(directory, { recursive: true, force: true });
  return true;
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
    return readFileSync(join(root, slug, "SKILL.md"), "utf8");
  } catch {
    return void 0;
  }
}

// apps/fom-client/plugins/office-skills/platform.ts
import { readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
var PLATFORM_SKILLS_DIR = "platform-skills";
var APPLIED_FILE = ".applied.json";
function asRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function skillFromEntry(entry) {
  const record = asRecord(entry);
  if (record === void 0 || record.kind !== "skill") return void 0;
  const spec = asRecord(record.spec);
  if (spec === void 0) return void 0;
  const slug = typeof spec.slug === "string" ? spec.slug : "";
  const body = typeof spec.body === "string" ? spec.body : "";
  if (slug === "" || body === "") return void 0;
  return {
    slug,
    name: typeof spec.name === "string" && spec.name !== "" ? spec.name : slug,
    description: typeof spec.description === "string" ? spec.description : "",
    body,
    version: typeof record.version === "string" ? record.version : "",
    contentHash: typeof record.contentHash === "string" ? record.contentHash : ""
  };
}
function readApplied(root) {
  try {
    const parsed = JSON.parse(readFileSync2(join2(root, APPLIED_FILE), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}
function writeApplied(root, applied) {
  writeFileSync2(join2(root, APPLIED_FILE), `${JSON.stringify(applied, void 0, 2)}
`);
}
function materializePlatformSkills(root, entries, applied = {}) {
  const skills = /* @__PURE__ */ new Map();
  let skipped = 0;
  for (const entry of entries) {
    const skill = skillFromEntry(entry);
    if (skill === void 0) {
      skipped += 1;
      continue;
    }
    skills.set(skill.slug, skill);
  }
  const written = [];
  const updated = [];
  const unchanged = [];
  const next = {};
  for (const [slug, skill] of skills) {
    const previous = applied[slug];
    const same = previous !== void 0 && previous.version === skill.version && previous.contentHash === skill.contentHash;
    if (same) {
      unchanged.push(slug);
    } else {
      writeManagedSkill(root, skill);
      if (previous === void 0) written.push(slug);
      else updated.push(slug);
    }
    next[slug] = { version: skill.version, contentHash: skill.contentHash };
  }
  const removed = [];
  for (const slug of listManagedSkills(root)) {
    if (!skills.has(slug)) {
      removeManagedSkill(root, slug);
      removed.push(slug);
    }
  }
  return {
    written: written.sort(),
    updated: updated.sort(),
    removed: removed.sort(),
    unchanged: unchanged.sort(),
    skipped,
    applied: next
  };
}

// apps/fom-client/plugins/office-skills/index.ts
var SKILLS = [
  {
    name: "meeting-minutes",
    // 中文名前置（`/` 菜单主标签只能是 kebab-case 标识，故把中文展示名放进描述——菜单会显示）。
    description: "\u4F1A\u8BAE\u7EAA\u8981\u5206\u53D1 \u2014\u2014 \u628A\u4F1A\u8BAE\u8BB0\u5F55/\u8F6C\u5F55\u6574\u7406\u6210\u7ED3\u6784\u5316\u4F1A\u8BAE\u7EAA\u8981\u5E76\u5206\u53D1\uFF1A\u7ED9\u51FA\u7ED3\u8BBA\u4E0E\u5F85\u529E\uFF08\u542B\u8D1F\u8D23\u4EBA\u3001\u671F\u9650\uFF09\uFF0C\u53EF\u53D1\u5E03\u4E3A\u98DE\u4E66\u4E91\u6587\u6863\u3002\u5F53\u8F93\u5165\u662F\u4F1A\u8BAE\u5F55\u97F3\u8F6C\u5F55\u3001\u4F1A\u8BAE\u7EAA\u8981\u6587\u6863\uFF0C\u6216\u7528\u6237\u8981\u6C42\u300C\u6574\u7406/\u5206\u53D1\u4F1A\u8BAE\u7EAA\u8981\u300D\u65F6\u4F7F\u7528\u3002"
  },
  {
    name: "weekly-report",
    description: "\u5468\u62A5\u6C47\u603B \u2014\u2014 \u6C47\u603B\u4E00\u5468\u5DE5\u4F5C\u6570\u636E\uFF08\u591A\u7EF4\u8868\u683C\u8BB0\u5F55 / \u65E5\u5386\u65E5\u7A0B / \u5DE5\u4F5C\u533A\u6587\u4EF6\uFF09\u751F\u6210\u7ED3\u6784\u5316\u5468\u62A5\uFF0C\u53EF\u53D1\u5E03\u4E3A\u98DE\u4E66\u4E91\u6587\u6863\u3002\u5F53\u7528\u6237\u8981\u6C42\u300C\u5199\u5468\u62A5 / \u6C47\u603B\u672C\u5468\u5DE5\u4F5C\u300D\u6216\u63D0\u4F9B\u4E86\u591A\u7EF4\u8868\u683C\u3001\u65E5\u5386\u6570\u636E\u65F6\u4F7F\u7528\u3002"
  },
  {
    name: "skill-creator",
    // ⚠️ 这条 description 与 `assets/skill-creator/SKILL.md` 的 frontmatter **必须逐字一致**：
    // bundled provider 只读这里、不读 frontmatter，而 managed/platform 只读 frontmatter ⇒
    // 两份描述天生会漂。`index.spec.ts` 有一条一致性测试钉住它（《详细实施-skill-creator内置技能v0.1》D-2）。
    description: "\u6280\u80FD\u521B\u5EFA\u52A9\u624B \u2014\u2014 \u5728\u672C\u673A\u5FEB\u6377\u521B\u5EFA\u300C\u7528\u6237\u81EA\u5EFA\u6280\u80FD\u300D\uFF1A\u8BB2\u6E05\u4E09\u4E2A\u6280\u80FD\u6839\u4E0E\u4F18\u5148\u7EA7\u3001$DSH_HOME \u600E\u4E48\u89E3\u6790\u3001SKILL.md \u7684\u5F62\u72B6\u4E0E slug \u89C4\u5219\u3001\u4E09\u6761\u521B\u5EFA\u8DEF\u5F84\uFF08write \u5DE5\u5177 / \u63A7\u5236\u53F0\u7AEF\u70B9 / UI\uFF09\u4E0E\u5404\u81EA\u751F\u6548\u65F6\u673A\u3001\u5199\u5B8C\u600E\u4E48\u9A8C\u8BC1\uFF08\u65B0\u5F00\u4F1A\u8BDD\u53EF\u89C1\u3001\u4E0D\u7528\u91CD\u542F\uFF09\u3001\u4EE5\u53CA\u5220\u9664/\u5BFC\u51FA/\u5BFC\u5165\u3002\u5F53\u7528\u6237\u8981\u6C42\u300C\u65B0\u5EFA/\u5199\u4E00\u4E2A\u6280\u80FD\u300D\u300C\u628A\u67D0\u6BB5\u5DE5\u4F5C\u6D41\u56FA\u5316\u6210\u6280\u80FD\u300D\u300C\u6280\u80FD\u653E\u54EA/\u600E\u4E48\u751F\u6548\u300D\u65F6\u4F7F\u7528\u3002"
  }
];
var MANAGED_SKILL_RANK = 500;
var PLATFORM_SKILL_RANK = 550;
var WATCH_DEBOUNCE_MS = 150;
var WATCH_POLL_INTERVAL_MS = 500;
var Config = z.object({
  assetRoot: z.string().default(""),
  managedRoot: z.string().default(""),
  platformRoot: z.string().default(""),
  platformUrl: z.string().default("http://localhost:5028"),
  skills: z.array(z.string()).default([])
});
var name = "office-skills";
var inject = ["skills"];
function createOfficeSkillsProvider(assetRoot, filter = []) {
  if (!isAbsolute(assetRoot)) throw new Error("office-skills: assetRoot \u5FC5\u987B\u662F\u7EDD\u5BF9\u8DEF\u5F84");
  const selected = filter.length === 0 ? SKILLS : SKILLS.filter((skill) => filter.includes(skill.name));
  const candidates = selected.map((skill) => {
    const directory = join3(assetRoot, skill.name);
    const path = join3(directory, "SKILL.md");
    readFileSync3(path, "utf8");
    return {
      name: skill.name,
      description: skill.description,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: "dsh-office-platform",
      source: "bundled",
      rank: BUNDLED_SKILL_RANK,
      resourceBase: { kind: "directory", path: directory },
      locator: path
    };
  });
  return {
    name: "dsh-office-platform",
    list: () => Promise.resolve(candidates),
    async get(candidate, options) {
      const { rank: _rank, locator, ...summary } = candidate;
      const raw = await readFile(locator, { encoding: "utf8", signal: options.signal });
      return { ...summary, content: skillBody(raw) };
    }
  };
}
function createManagedSkillsProvider(managedRoot, filter = []) {
  if (!isAbsolute(managedRoot)) throw new Error("office-skills: managedRoot \u5FC5\u987B\u662F\u7EDD\u5BF9\u8DEF\u5F84");
  return {
    name: "dsh-office-managed-skills",
    list: () => Promise.resolve(listManagedSkills(managedRoot).filter((slug) => filter.length === 0 || filter.includes(slug)).map((slug) => {
      const directory = join3(managedRoot, slug);
      const raw = readManagedSkill(managedRoot, slug) ?? "";
      const meta = parseSkillFrontmatter(raw);
      return {
        name: slug,
        description: meta.description ?? meta.name ?? slug,
        invocation: { modelInvocable: true, userInvocable: true },
        provider: "dsh-office-managed-skills",
        source: "custom",
        rank: MANAGED_SKILL_RANK,
        resourceBase: { kind: "directory", path: directory },
        locator: join3(directory, "SKILL.md")
      };
    })),
    async get(candidate, options) {
      const { rank: _rank, locator, ...summary } = candidate;
      const raw = await readFile(locator, { encoding: "utf8", signal: options.signal });
      return { ...summary, content: skillBody(raw) };
    }
  };
}
function createPlatformSkillsProvider(platformRoot, filter = []) {
  if (!isAbsolute(platformRoot)) throw new Error("office-skills: platformRoot \u5FC5\u987B\u662F\u7EDD\u5BF9\u8DEF\u5F84");
  return {
    name: "dsh-office-platform-skills",
    list: () => Promise.resolve(listManagedSkills(platformRoot).filter((slug) => filter.length === 0 || filter.includes(slug)).map((slug) => {
      const directory = join3(platformRoot, slug);
      const raw = readManagedSkill(platformRoot, slug) ?? "";
      const meta = parseSkillFrontmatter(raw);
      return {
        name: slug,
        description: meta.description ?? meta.name ?? slug,
        invocation: { modelInvocable: true, userInvocable: true },
        provider: "dsh-office-platform-skills",
        source: "platform",
        rank: PLATFORM_SKILL_RANK,
        resourceBase: { kind: "directory", path: directory },
        locator: join3(directory, "SKILL.md")
      };
    })),
    async get(candidate, options) {
      const { rank: _rank, locator, ...summary } = candidate;
      const raw = await readFile(locator, { encoding: "utf8", signal: options.signal });
      return { ...summary, content: skillBody(raw) };
    }
  };
}
function dshHome() {
  const home = process.env.DSH_HOME;
  return home !== void 0 && home !== "" ? home : join3(homedir(), ".dsh");
}
function resolveBundledAssets(moduleUrl) {
  for (const relative2 of ["./assets/", "../assets/"]) {
    const directory = fileURLToPath(new URL(relative2, moduleUrl));
    if (existsSync3(directory)) return directory;
  }
  return fileURLToPath(new URL("./assets/", moduleUrl));
}
var PLATFORM_TOKEN_REF = "FOM_PLATFORM_TOKEN";
var SYNC_ROUTE = "/api/office/skills/sync";
function isSkillRootPath(root, path) {
  const child = relative(root, path);
  if (child === "" || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) return false;
  const segments = child.split(/[/\\]/u);
  if (segments.length === 1) return segments[0]?.endsWith(".md") === true;
  return segments.length === 2 && segments[1] === "SKILL.md";
}
function watchSkillRoot(root, onChange) {
  const watchers = /* @__PURE__ */ new Map();
  let timer;
  let closed = false;
  const fire = () => {
    if (closed) return;
    if (timer !== void 0) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = void 0;
      if (closed) return;
      syncDirs();
      onChange();
    }, WATCH_DEBOUNCE_MS);
  };
  const attach = (directory) => {
    if (closed || watchers.has(directory)) return;
    try {
      const watcher = watch(directory, { persistent: false }, fire);
      watcher.on("error", () => {
        watchers.delete(directory);
      });
      watchers.set(directory, watcher);
    } catch {
    }
  };
  function syncDirs() {
    let entries;
    try {
      entries = readdirSync2(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) attach(join3(root, entry.name));
    }
  }
  if (existsSync3(root)) {
    attach(root);
    syncDirs();
  } else {
    watchFile(root, { persistent: false, interval: WATCH_POLL_INTERVAL_MS }, () => {
      if (closed) return;
      unwatchFile(root);
      attach(root);
      syncDirs();
    });
  }
  return () => {
    closed = true;
    if (timer !== void 0) clearTimeout(timer);
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  };
}
function apply(ctx, config) {
  const assetRoot = config.assetRoot === "" ? resolveBundledAssets(import.meta.url) : config.assetRoot;
  const managedRoot = config.managedRoot === "" ? join3(dshHome(), "office", MANAGED_SKILLS_DIR) : config.managedRoot;
  const platformRoot = config.platformRoot === "" ? join3(dshHome(), "office", PLATFORM_SKILLS_DIR) : config.platformRoot;
  const platformUrl = config.platformUrl.replace(/\/+$/u, "");
  ctx.effect(() => {
    const disposeBundled = ctx.skills.registerProvider(() => createOfficeSkillsProvider(assetRoot, config.skills));
    const registerManaged = () => ctx.skills.registerProvider(() => createManagedSkillsProvider(managedRoot, config.skills));
    const registerPlatform = () => ctx.skills.registerProvider(() => createPlatformSkillsProvider(platformRoot, config.skills));
    let disposeManaged = registerManaged();
    let disposePlatform = registerPlatform();
    const refresh = () => {
      disposeManaged();
      disposeManaged = registerManaged();
      disposePlatform();
      disposePlatform = registerPlatform();
    };
    const isSkillMutation = (path) => isSkillRootPath(managedRoot, path) || isSkillRootPath(platformRoot, path);
    ctx.on("fs/observed", (target, _observation, actor) => {
      const tool = actor?.name;
      if (tool !== "write" && tool !== "edit") return;
      const path = target?.displayPath;
      if (typeof path !== "string" || !isSkillMutation(path)) return;
      refresh();
    });
    const unwatchManaged = watchSkillRoot(managedRoot, refresh);
    const unwatchPlatform = watchSkillRoot(platformRoot, refresh);
    const sync = async () => {
      const credentials = ctx.get("credentials");
      const token = (await credentials?.resolve?.(PLATFORM_TOKEN_REF))?.value ?? "";
      const headers = { accept: "application/json" };
      if (token !== "") headers.authorization = `Bearer ${token}`;
      const res = await fetch(`${platformUrl}/api/config/catalog`, { headers });
      if (!res.ok) throw new Error(`\u5E73\u53F0\u76EE\u5F55\u4E0B\u53D1\u5931\u8D25\uFF1AHTTP ${res.status}`);
      const payload = await res.json();
      const result = materializePlatformSkills(platformRoot, Array.isArray(payload) ? payload : [], readApplied(platformRoot));
      writeApplied(platformRoot, result.applied);
      refresh();
      return result;
    };
    const disposeService = ctx.reflect.provide("officeSkills", { refresh, sync });
    return () => {
      unwatchManaged();
      unwatchPlatform();
      disposePlatform();
      disposeManaged();
      disposeBundled();
      disposeService();
    };
  });
  ctx.inject(["connection"], (connCtx) => {
    connCtx.effect(() => {
      const conn = connCtx.get("connection");
      if (conn === void 0) return () => {
      };
      const dispose = conn.fetch.register({
        path: SYNC_ROUTE,
        methods: ["POST"],
        requestBody: "buffered",
        fetch: async () => {
          const service = ctx.get("officeSkills");
          if (service === void 0) {
            return new Response(JSON.stringify({ ok: false, message: "officeSkills \u670D\u52A1\u7F3A\u5931" }), { status: 500, headers: { "content-type": "application/json" } });
          }
          try {
            const result = await service.sync();
            return new Response(JSON.stringify({ ok: true, ...result }), { status: 200, headers: { "content-type": "application/json" } });
          } catch (error) {
            return new Response(JSON.stringify({ ok: false, message: String(error?.message ?? error) }), { status: 200, headers: { "content-type": "application/json" } });
          }
        }
      });
      return () => {
        void dispose();
      };
    }, "office-skills: C5 \u5E73\u53F0\u76EE\u5F55\u540C\u6B65\u8DEF\u7531");
  });
}
var OfficeSkills = {
  name,
  inject,
  Config,
  apply
};
var index_default = OfficeSkills;
export {
  APPLIED_FILE,
  MANAGED_SKILLS_DIR,
  OfficeSkills,
  PLATFORM_SKILLS_DIR,
  PLATFORM_TOKEN_REF,
  SYNC_ROUTE,
  apply,
  createManagedSkillsProvider,
  createOfficeSkillsProvider,
  createPlatformSkillsProvider,
  index_default as default,
  inject,
  isSkillRootPath,
  isValidSkillSlug,
  listManagedSkills,
  materializePlatformSkills,
  name,
  parseSkillFrontmatter,
  readApplied,
  readManagedSkill,
  removeManagedSkill,
  renderSkillMarkdown,
  resolveBundledAssets,
  skillBody,
  skillFromEntry,
  watchSkillRoot,
  writeApplied,
  writeManagedSkill
};

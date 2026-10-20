// apps/fom-client/plugins/office-console/index.ts
import { join as join4 } from "node:path";
import z from "@deepseek-ai/schemastery";

// apps/fom-client/plugins/office-authz/roles.ts
var ACTION_POLICY = Object.freeze({
  "console.view": { allow: ["owner", "admin", "member"], requiresApproval: false },
  "capability.toggle": { allow: ["owner", "admin"], requiresApproval: false },
  "bundle.install": { allow: ["owner", "admin"], requiresApproval: true },
  "bundle.remove": { allow: ["owner", "admin"], requiresApproval: true },
  "connector.install": { allow: ["owner", "admin"], requiresApproval: true },
  "connector.remove": { allow: ["owner", "admin"], requiresApproval: true },
  "config.edit": { allow: ["owner", "admin"], requiresApproval: true },
  "skill.create": { allow: ["owner", "admin", "member"], requiresApproval: false },
  "skill.remove": { allow: ["owner", "admin", "member"], requiresApproval: false },
  "skill.export": { allow: ["owner", "admin", "member"], requiresApproval: false },
  "skill.import": { allow: ["owner", "admin", "member"], requiresApproval: false },
  "expert.create": { allow: ["owner", "admin", "member"], requiresApproval: false },
  "expert.remove": { allow: ["owner", "admin", "member"], requiresApproval: false },
  "expert.export": { allow: ["owner", "admin", "member"], requiresApproval: false },
  "expert.import": { allow: ["owner", "admin", "member"], requiresApproval: false },
  "approval.decide": { allow: ["owner", "admin"], requiresApproval: false }
});
var OFFICE_ACTIONS = Object.freeze([
  "console.view",
  "capability.toggle",
  "bundle.install",
  "bundle.remove",
  "connector.install",
  "connector.remove",
  "config.edit",
  "skill.create",
  "skill.remove",
  "skill.export",
  "skill.import",
  "expert.create",
  "expert.remove",
  "expert.export",
  "expert.import",
  "approval.decide"
]);
var OFFICE_ROLES = Object.freeze(["owner", "admin", "member", "guest"]);
function can(role, action) {
  const policy = ACTION_POLICY[action];
  return policy !== void 0 && policy.allow.includes(role);
}
function requiresApproval(action) {
  const policy = ACTION_POLICY[action];
  return policy === void 0 ? true : policy.requiresApproval;
}

// apps/fom-client/plugins/office-console/actions-route.ts
var ACTIONS_ROUTE = "/office/console/actions";
function parseRole(url) {
  const value = new URL(url ?? "/", "http://localhost").searchParams.get("role");
  if (value === null) return void 0;
  return OFFICE_ROLES.includes(value) ? value : void 0;
}
function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
function createActionsHandler(authz) {
  return (request, response) => {
    if (request.method !== "GET") {
      json(response, 405, { code: "method-not-allowed" });
      return;
    }
    const role = parseRole(request.url);
    if (role === void 0) {
      json(response, 400, { code: "role-required", roles: OFFICE_ROLES });
      return;
    }
    const decisions = OFFICE_ACTIONS.map((action) => ({
      action,
      allowed: authz.can(role, action),
      requiresApproval: authz.requiresApproval(action)
    }));
    json(response, 200, { role, decisions });
  };
}

// apps/fom-client/plugins/office-authz/actions.ts
async function runConsoleAction(input, execute) {
  if (!can(input.role, input.action)) {
    return { status: "forbidden", reason: `\u89D2\u8272 ${input.role} \u4E0D\u5141\u8BB8\u52A8\u4F5C ${input.action}` };
  }
  if (requiresApproval(input.action) && !input.approved) {
    return { status: "needs-approval" };
  }
  return { status: "done", value: await execute() };
}

// apps/fom-client/plugins/office-console/console-actions.ts
var WRITE_ROUTE = "/api/office/console/action";
function createEchoExecutor() {
  return (action, payload) => ({ echoed: { action, payload } });
}
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
function parseWriteInput(body) {
  if (typeof body !== "object" || body === null) return void 0;
  const record2 = body;
  const action = record2.action;
  if (typeof action !== "string" || !OFFICE_ACTIONS.includes(action)) return void 0;
  return { action, payload: record2.payload, ...typeof record2.approvalId === "string" ? { approvalId: record2.approvalId } : {} };
}
function createWriteFetch(authz, execute, operatorRole, approvals) {
  return async (request) => {
    void authz;
    if (request.method !== "POST") return jsonResponse(405, { code: "method-not-allowed" });
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(400, { code: "invalid-json" });
    }
    const input = parseWriteInput(body);
    if (input === void 0) {
      return jsonResponse(400, { code: "invalid-input", actions: OFFICE_ACTIONS });
    }
    const approved = input.approvalId !== void 0 && approvals.consume(input.approvalId, input.action, input.payload);
    let result;
    try {
      result = await runConsoleAction({ role: operatorRole, action: input.action, approved }, () => execute(input.action, input.payload));
    } catch (error) {
      const code = error?.code;
      if (code === "invalid-input") {
        return jsonResponse(400, { code: "invalid-input", message: error instanceof Error ? error.message : String(error) });
      }
      return jsonResponse(500, { code: "execution-failed", message: error instanceof Error ? error.message : String(error) });
    }
    if (result.status === "done") return jsonResponse(200, result);
    if (result.status === "forbidden") return jsonResponse(403, result);
    const record2 = approvals.request(input.action, input.payload);
    return jsonResponse(202, { status: "needs-approval", approvalId: record2.id });
  };
}

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
function readManagedSkill(root, slug) {
  try {
    return readFileSync(join(root, slug, "SKILL.md"), "utf8");
  } catch {
    return void 0;
  }
}

// apps/fom-client/plugins/office-experts/delta.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, readdirSync as readdirSync2, rmSync as rmSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
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
function readExpertDelta(dir, id) {
  try {
    return parseExpertDelta(JSON.parse(readFileSync2(join2(dir, `${id}.json`), "utf8"))).delta;
  } catch {
    return void 0;
  }
}
function writeExpertDelta(dir, delta) {
  if (!isValidExpertId(delta.id)) throw new Error(`\u975E\u6CD5\u4E13\u5BB6 id\uFF1A${delta.id}`);
  mkdirSync2(dir, { recursive: true });
  const path = join2(dir, `${delta.id}.json`);
  writeFileSync2(path, `${JSON.stringify(delta, void 0, 2)}
`);
  return path;
}
function removeExpertDelta(dir, id) {
  if (!isValidExpertId(id)) return false;
  const path = join2(dir, `${id}.json`);
  if (!existsSync2(path)) return false;
  rmSync2(path, { force: true });
  return true;
}

// apps/fom-client/plugins/office-console/portable.ts
var PORTABLE_VERSION = 1;
var SKILL_KIND = "fom-skill";
var EXPERT_KIND = "fom-expert";
function asRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function exportSkill(spec) {
  return { kind: SKILL_KIND, version: PORTABLE_VERSION, slug: spec.slug, name: spec.name, description: spec.description, body: spec.body };
}
function exportExpert(delta) {
  return {
    kind: EXPERT_KIND,
    version: PORTABLE_VERSION,
    id: delta.id,
    name: delta.name,
    description: delta.description,
    persona: { ...delta.persona },
    tools: { ...delta.tools },
    ...delta.skills === void 0 ? {} : { skills: [...delta.skills] }
  };
}
function parsePortableSkill(value) {
  const problems = [];
  const r = asRecord2(value);
  if (r === void 0) return { problems: ["\u4E0D\u662F\u5BF9\u8C61"] };
  if (r.kind !== SKILL_KIND) problems.push(`kind \u987B\u4E3A ${SKILL_KIND}\uFF08\u6536\u5230 ${JSON.stringify(r.kind)}\uFF09`);
  if (r.version !== PORTABLE_VERSION) problems.push(`version \u987B\u4E3A ${PORTABLE_VERSION}\uFF08\u6536\u5230 ${JSON.stringify(r.version)}\uFF09`);
  const slug = typeof r.slug === "string" ? r.slug : "";
  const name2 = typeof r.name === "string" ? r.name : "";
  const body = typeof r.body === "string" ? r.body : "";
  if (!isValidSkillSlug(slug)) problems.push(`slug \u975E\u6CD5\uFF1A${JSON.stringify(r.slug)}`);
  if (name2 === "") problems.push("\u7F3A name");
  if (body === "") problems.push("\u7F3A body");
  if (problems.length > 0) return { problems };
  return {
    problems,
    skill: { kind: SKILL_KIND, version: PORTABLE_VERSION, slug, name: name2, description: typeof r.description === "string" ? r.description : "", body }
  };
}
function parsePortableExpert(value) {
  const r = asRecord2(value);
  if (r === void 0) return { problems: ["\u4E0D\u662F\u5BF9\u8C61"] };
  const problems = [];
  if (r.kind !== EXPERT_KIND) problems.push(`kind \u987B\u4E3A ${EXPERT_KIND}\uFF08\u6536\u5230 ${JSON.stringify(r.kind)}\uFF09`);
  if (r.version !== PORTABLE_VERSION) problems.push(`version \u987B\u4E3A ${PORTABLE_VERSION}\uFF08\u6536\u5230 ${JSON.stringify(r.version)}\uFF09`);
  const { delta, problems: deltaProblems } = parseExpertDelta(value);
  problems.push(...deltaProblems);
  if (problems.length > 0 || delta === void 0) return { problems };
  return { problems, expert: exportExpert(delta) };
}
function portableKind(value) {
  const kind = asRecord2(value)?.kind;
  if (kind === SKILL_KIND) return "skill";
  if (kind === EXPERT_KIND) return "expert";
  return void 0;
}

// apps/fom-client/plugins/office-console/executor.ts
var OfficeInputError = class extends Error {
  code = "invalid-input";
  constructor(message) {
    super(message);
    this.name = "OfficeInputError";
  }
};
function createCapabilityStore(seed, persist) {
  const map = new Map(seed.map((entry) => [entry.id, { id: entry.id, enabled: entry.enabled }]));
  const notify = () => {
    persist?.([...map.values()].map((state) => ({ ...state })));
  };
  return {
    list: () => [...map.values()].map((state) => ({ ...state })),
    get: (id) => {
      const state = map.get(id);
      return state === void 0 ? void 0 : { ...state };
    },
    setEnabled: (id, enabled) => {
      const state = map.get(id);
      if (state === void 0) return void 0;
      state.enabled = enabled;
      notify();
      return { ...state };
    }
  };
}
function record(payload) {
  return typeof payload === "object" && payload !== null ? payload : {};
}
function createConsoleExecutor(deps) {
  return async (action, payload) => {
    const p = record(payload);
    switch (action) {
      case "capability.toggle": {
        const id = p.id;
        const on = p.on;
        if (typeof id !== "string" || typeof on !== "boolean") throw new OfficeInputError("capability.toggle \u9700\u8981 { id, on }");
        const next = deps.store.setEnabled(id, on);
        if (next === void 0) throw new OfficeInputError(`\u672A\u77E5\u80FD\u529B\uFF1A${id}`);
        return { capability: next };
      }
      case "bundle.install":
      case "bundle.remove": {
        const spec = p.spec;
        if (typeof spec !== "string" || spec === "") throw new OfficeInputError(`${action} \u9700\u8981 { spec }`);
        if (deps.installer === void 0) return { dryRun: true, action, spec };
        const result = action === "bundle.install" ? await deps.installer.install(spec) : await deps.installer.remove(spec);
        return { result };
      }
      case "connector.install":
      case "connector.remove": {
        const id = p.id;
        const ref = p.ref;
        if (typeof id !== "string" || id === "") throw new OfficeInputError(`${action} \u9700\u8981 { id }`);
        if (typeof ref !== "string" || ref === "") throw new OfficeInputError(`${action} \u9700\u8981 { ref }`);
        const install = action === "connector.install";
        if (deps.installer === void 0) return { dryRun: true, action, id, ref };
        const result = install ? await deps.installer.install(ref) : await deps.installer.remove(ref);
        const capability = deps.store.setEnabled(id, install);
        return { connector: capability ?? { id, enabled: install }, result };
      }
      case "config.edit":
        return { accepted: true, action, payload: p };
      case "skill.create": {
        const slug = p.slug;
        const name2 = p.name;
        const body = p.body;
        if (typeof slug !== "string" || slug === "") throw new OfficeInputError("skill.create \u9700\u8981 { slug }");
        if (typeof name2 !== "string" || name2 === "") throw new OfficeInputError("skill.create \u9700\u8981 { name }");
        if (typeof body !== "string" || body === "") throw new OfficeInputError("skill.create \u9700\u8981 { body }");
        if (!isValidSkillSlug(slug)) throw new OfficeInputError(`\u975E\u6CD5\u6280\u80FD slug\uFF1A${slug}`);
        if (deps.skills === void 0) return { dryRun: true, action, slug };
        const path = deps.skills.create({ slug, name: name2, description: typeof p.description === "string" ? p.description : "", body });
        return { skill: { slug, path } };
      }
      case "skill.remove": {
        const slug = p.slug;
        if (typeof slug !== "string" || slug === "") throw new OfficeInputError("skill.remove \u9700\u8981 { slug }");
        if (deps.skills === void 0) return { dryRun: true, action, slug };
        return { skill: { slug, removed: deps.skills.remove(slug) } };
      }
      case "skill.export": {
        const slug = p.slug;
        if (typeof slug !== "string" || slug === "") throw new OfficeInputError("skill.export \u9700\u8981 { slug }");
        if (deps.skills === void 0) return { dryRun: true, action, slug };
        const spec = deps.skills.read(slug);
        if (spec === void 0) throw new OfficeInputError(`\u6280\u80FD\u4E0D\u5B58\u5728\uFF1A${slug}`);
        return { bundle: exportSkill(spec) };
      }
      case "skill.import": {
        const { skill, problems } = parsePortableSkill(p.bundle);
        if (skill === void 0) throw new OfficeInputError(`\u6280\u80FD\u5305\u975E\u6CD5\uFF1A${problems.join("\uFF1B")}`);
        if (deps.skills === void 0) return { dryRun: true, action, slug: skill.slug };
        const path = deps.skills.create(skill);
        return { skill: { slug: skill.slug, path } };
      }
      case "expert.create": {
        const id = p.id;
        const name2 = p.name;
        if (typeof id !== "string" || id === "") throw new OfficeInputError("expert.create \u9700\u8981 { id }");
        if (typeof name2 !== "string" || name2 === "") throw new OfficeInputError("expert.create \u9700\u8981 { name }");
        if (!isValidExpertId(id)) throw new OfficeInputError(`\u975E\u6CD5\u4E13\u5BB6 id\uFF1A${id}`);
        if (deps.experts === void 0) return { dryRun: true, action, id };
        const record2 = (key) => typeof p[key] === "object" && p[key] !== null ? p[key] : {};
        const path = await deps.experts.create({
          id,
          name: name2,
          description: typeof p.description === "string" ? p.description : "",
          persona: record2("persona"),
          tools: record2("tools"),
          ...Array.isArray(p.skills) ? { skills: p.skills.filter((s) => typeof s === "string") } : {}
        });
        return { expert: { id, path } };
      }
      case "expert.remove": {
        const id = p.id;
        if (typeof id !== "string" || id === "") throw new OfficeInputError("expert.remove \u9700\u8981 { id }");
        if (deps.experts === void 0) return { dryRun: true, action, id };
        return { expert: { id, removed: deps.experts.remove(id) } };
      }
      case "expert.export": {
        const id = p.id;
        if (typeof id !== "string" || id === "") throw new OfficeInputError("expert.export \u9700\u8981 { id }");
        if (deps.experts === void 0) return { dryRun: true, action, id };
        const spec = deps.experts.read(id);
        if (spec === void 0) throw new OfficeInputError(`\u4E13\u5BB6\u4E0D\u5B58\u5728\uFF1A${id}`);
        return { bundle: exportExpert(spec) };
      }
      case "expert.import": {
        const { expert, problems } = parsePortableExpert(p.bundle);
        if (expert === void 0) throw new OfficeInputError(`\u4E13\u5BB6\u5305\u975E\u6CD5\uFF1A${problems.join("\uFF1B")}`);
        if (deps.experts === void 0) return { dryRun: true, action, id: expert.id };
        const path = await deps.experts.create(expert);
        return { expert: { id: expert.id, path } };
      }
      case "approval.decide": {
        const id = p.id;
        const decision = p.decision;
        if (typeof id !== "string" || decision !== "grant" && decision !== "reject") {
          throw new OfficeInputError("approval.decide \u9700\u8981 { id, decision: grant|reject }");
        }
        if (deps.approvals === void 0) throw new Error("approval.decide \u4E0D\u53EF\u7528\uFF1A\u672A\u6CE8\u5165\u5BA1\u6279\u5B58\u50A8");
        const record2 = decision === "grant" ? deps.approvals.grant(id) : deps.approvals.reject(id);
        if (record2 === void 0) throw new OfficeInputError(`\u5BA1\u6279\u4E0D\u53EF\u88C1\u51B3\uFF08\u4E0D\u5B58\u5728\u6216\u975E pending\uFF09\uFF1A${id}`);
        return { approval: record2 };
      }
      default:
        throw new OfficeInputError(`\u672A\u5904\u7406\u7684\u52A8\u4F5C\uFF1A${String(action)}`);
    }
  };
}

// apps/fom-client/plugins/office-console/approvals.ts
import { createHash, randomUUID } from "node:crypto";
function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record2 = value;
  const keys = Object.keys(record2).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(record2[key])}`).join(",")}}`;
}
function digestOf(action, payload) {
  return createHash("sha1").update(stable({ action, payload })).digest("hex");
}
function createApprovalStore(newId = randomUUID, options = {}) {
  const map = /* @__PURE__ */ new Map();
  for (const record2 of options.initial ?? []) map.set(record2.id, { ...record2 });
  const notify = () => {
    options.persist?.([...map.values()].map((record2) => ({ ...record2 })));
  };
  return {
    request(action, payload) {
      const digest = digestOf(action, payload);
      for (const record3 of map.values()) {
        if (record3.status === "pending" && record3.action === action && record3.digest === digest) return record3;
      }
      const record2 = { id: newId(), action, digest, status: "pending" };
      map.set(record2.id, record2);
      notify();
      return record2;
    },
    get: (id) => {
      const record2 = map.get(id);
      return record2 === void 0 ? void 0 : { ...record2 };
    },
    list: () => [...map.values()].map((record2) => ({ ...record2 })),
    grant(id) {
      const record2 = map.get(id);
      if (record2 === void 0 || record2.status !== "pending") return void 0;
      record2.status = "granted";
      notify();
      return { ...record2 };
    },
    reject(id) {
      const record2 = map.get(id);
      if (record2 === void 0 || record2.status !== "pending") return void 0;
      record2.status = "rejected";
      notify();
      return { ...record2 };
    },
    consume(id, action, payload) {
      const record2 = map.get(id);
      if (record2 === void 0 || record2.status !== "granted") return false;
      if (record2.action !== action || record2.digest !== digestOf(action, payload)) return false;
      record2.status = "consumed";
      notify();
      return true;
    }
  };
}

// apps/fom-client/plugins/office-console/installer.ts
function createPluginManagerInstaller(pm) {
  return {
    install: (spec) => pm.installBundle(spec),
    remove: (spec) => pm.removeBundle(spec)
  };
}

// apps/fom-client/plugins/office-console/persist.ts
import { mkdirSync as mkdirSync3, readFileSync as readFileSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { homedir } from "node:os";
import { dirname, join as join3 } from "node:path";
function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync3(path, "utf8"));
  } catch {
    return void 0;
  }
}
function writeJsonFile(path, value) {
  mkdirSync3(dirname(path), { recursive: true });
  writeFileSync3(path, `${JSON.stringify(value, void 0, 2)}
`);
}
function resolveDshHome() {
  const home = process.env.DSH_HOME;
  return home !== void 0 && home !== "" ? home : join3(homedir(), ".dsh");
}
function consoleStateDir(home = resolveDshHome()) {
  return join3(home, "office");
}

// apps/fom-client/plugins/office-console/state-route.ts
var STATE_ROUTE = "/office/console/state";
function json2(response, status, body) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}
function createStateHandler(store, operatorRole) {
  return (request, response) => {
    if (request.method !== "GET") {
      json2(response, 405, { code: "method-not-allowed" });
      return;
    }
    json2(response, 200, { operatorRole, capabilities: store.list() });
  };
}

// apps/fom-client/plugins/office-console/index.ts
var CATALOG_ROUTE = "/office/catalog";
function createCatalogHandler(catalog) {
  return (request, response) => {
    if (request.method !== "GET") {
      response.writeHead(405, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "method-not-allowed" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ version: catalog.version, entries: catalog.list() }));
  };
}
var name = "office-console";
var inject = ["officeCatalog", "officeAuthz"];
var Config = z.object({
  operatorRole: z.string().default("owner"),
  enableInstaller: z.boolean().default(false)
});
function apply(ctx, config) {
  const operatorRole = config.operatorRole;
  if (!OFFICE_ROLES.includes(operatorRole)) {
    throw new Error(`office-console: operatorRole \u975E\u6CD5\uFF08\u987B\u4E3A ${OFFICE_ROLES.join("/")}\uFF09\uFF1A${operatorRole}`);
  }
  const catalog = ctx.get("officeCatalog");
  if (catalog === void 0) {
    throw new Error("office-console: officeCatalog \u670D\u52A1\u7F3A\u5931\uFF08\u9700\u4E0E office-catalog \u4E00\u8D77\u6302\uFF09");
  }
  const authz = ctx.get("officeAuthz");
  if (authz === void 0) {
    throw new Error("office-console: officeAuthz \u670D\u52A1\u7F3A\u5931\uFF08\u9700\u4E0E office-authz \u4E00\u8D77\u6302\uFF09");
  }
  const stateDir = consoleStateDir();
  const enabledPath = join4(stateDir, "console-enabled.json");
  const approvalsPath = join4(stateDir, "console-approvals.json");
  const savedEnabled = readJsonFile(enabledPath) ?? {};
  const store = createCapabilityStore(
    catalog.list().map((entry) => ({ id: entry.id, enabled: savedEnabled[entry.id] ?? entry.defaultEnabled })),
    (states) => writeJsonFile(enabledPath, Object.fromEntries(states.map((state) => [state.id, state.enabled])))
  );
  const approvals = createApprovalStore(void 0, {
    initial: readJsonFile(approvalsPath) ?? [],
    persist: (records) => writeJsonFile(approvalsPath, records)
  });
  const installer = config.enableInstaller === true ? createPluginManagerInstaller((() => {
    const pm = ctx.get("pluginManager");
    if (pm === void 0) throw new Error("office-console: enableInstaller \u5DF2\u5F00\u4F46 pluginManager \u670D\u52A1\u7F3A\u5931");
    return pm;
  })()) : void 0;
  const executor = createConsoleExecutor({
    store,
    approvals,
    skills: {
      create: (spec) => {
        const path = writeManagedSkill(join4(resolveDshHome(), "office", MANAGED_SKILLS_DIR), spec);
        ctx.get("officeSkills")?.refresh();
        return path;
      },
      remove: (slug) => {
        const removed = removeManagedSkill(join4(resolveDshHome(), "office", MANAGED_SKILLS_DIR), slug);
        ctx.get("officeSkills")?.refresh();
        return removed;
      },
      read: (slug) => {
        const raw = readManagedSkill(join4(resolveDshHome(), "office", MANAGED_SKILLS_DIR), slug);
        if (raw === void 0) return void 0;
        const front = parseSkillFrontmatter(raw);
        return { slug, name: front.name ?? slug, description: front.description ?? "", body: skillBody(raw) };
      }
    },
    experts: {
      create: (spec) => {
        const service = ctx.get("officeExperts");
        return service !== void 0 ? service.create(spec) : Promise.resolve(writeExpertDelta(join4(resolveDshHome(), "office", EXPERT_PRESETS_DIR), spec));
      },
      remove: (id) => {
        const service = ctx.get("officeExperts");
        return service !== void 0 ? service.remove(id) : removeExpertDelta(join4(resolveDshHome(), "office", EXPERT_PRESETS_DIR), id);
      },
      read: (id) => readExpertDelta(join4(resolveDshHome(), "office", EXPERT_PRESETS_DIR), id)
    },
    ...installer !== void 0 ? { installer } : {}
  });
  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(() => {
      const server = webCtx.get("webServer");
      if (server === void 0) return () => {
      };
      const unregisterCatalog = server.register({ kind: "exact", path: CATALOG_ROUTE, handler: createCatalogHandler(catalog) });
      const unregisterActions = server.register({ kind: "exact", path: ACTIONS_ROUTE, handler: createActionsHandler(authz) });
      const unregisterState = server.register({ kind: "exact", path: STATE_ROUTE, handler: createStateHandler(store, operatorRole) });
      return () => {
        unregisterState();
        unregisterActions();
        unregisterCatalog();
      };
    }, "office-console: \u53EA\u8BFB\u8DEF\u7531\uFF08\u76EE\u5F55 + \u52A8\u4F5C\u51B3\u7B56 + \u72B6\u6001\uFF09");
  });
  ctx.inject(["connection"], (connCtx) => {
    connCtx.effect(() => {
      const conn = connCtx.get("connection");
      if (conn === void 0) return () => {
      };
      const dispose = conn.fetch.register({
        path: WRITE_ROUTE,
        methods: ["POST"],
        requestBody: "buffered",
        fetch: createWriteFetch(authz, executor, operatorRole, approvals)
      });
      return () => {
        void dispose();
      };
    }, "office-console: \u5199\u7AEF\u70B9\uFF08\u8BA4\u8BC1 Fetch \u8DEF\u7531\uFF09");
  });
}
var index_default = { name, inject, Config, apply };
export {
  ACTIONS_ROUTE,
  CATALOG_ROUTE,
  Config,
  EXPERT_KIND,
  OfficeInputError,
  PORTABLE_VERSION,
  SKILL_KIND,
  STATE_ROUTE,
  WRITE_ROUTE,
  apply,
  consoleStateDir,
  createActionsHandler,
  createApprovalStore,
  createCapabilityStore,
  createCatalogHandler,
  createConsoleExecutor,
  createEchoExecutor,
  createPluginManagerInstaller,
  createStateHandler,
  createWriteFetch,
  index_default as default,
  digestOf,
  exportExpert,
  exportSkill,
  inject,
  isValidExpertId,
  name,
  parsePortableExpert,
  parsePortableSkill,
  parseRole,
  parseWriteInput,
  portableKind,
  readJsonFile,
  resolveDshHome,
  writeJsonFile
};

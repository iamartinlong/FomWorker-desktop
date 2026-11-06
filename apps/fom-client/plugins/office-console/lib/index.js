// apps/fom-client/plugins/office-console/index.ts
import { join as join7 } from "node:path";
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
function createConnectorInstaller(pm) {
  return {
    installBundle: (spec) => pm.installBundle(spec),
    removeBundle: (name2) => pm.removeBundle(name2)
  };
}

// apps/fom-client/plugins/office-console/connector-routes.ts
var CONNECTOR_ROUTE = "/api/office/connector";
var CONNECTOR_ACTION = "connector.install";
function jsonResponse2(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}
function slugOf(request) {
  const value = new URL(request.url).searchParams.get("slug");
  return value !== null && value !== "" ? value : void 0;
}
function createConnectorFetch(authz, operatorRole, connectors) {
  return async (request) => {
    if (!OFFICE_ROLES.includes(operatorRole)) {
      return jsonResponse2(500, { ok: false, error: `\u670D\u52A1\u7AEF\u89D2\u8272\u975E\u6CD5\uFF1A${operatorRole}` });
    }
    if (!authz.can(operatorRole, CONNECTOR_ACTION)) {
      return jsonResponse2(403, { ok: false, error: "\u6CA1\u6709\u8FDE\u63A5\u5668\u914D\u7F6E\u6743\u9650" });
    }
    if (request.method === "GET") {
      const url = new URL(request.url);
      if (url.searchParams.get("new") === "1") {
        const transport = url.searchParams.get("transport") ?? void 0;
        const { form, values } = connectors.createForm(transport);
        return jsonResponse2(200, { ok: true, form, values });
      }
      const slug = slugOf(request);
      if (slug === void 0) return jsonResponse2(400, { ok: false, error: "\u7F3A\u5C11 slug \u53C2\u6570" });
      const view = connectors.configOf(slug);
      if (view === void 0) return jsonResponse2(404, { ok: false, error: `\u8FDE\u63A5\u5668\u4E0D\u5B58\u5728\uFF1A${slug}` });
      return jsonResponse2(200, { ok: true, ...view });
    }
    if (request.method !== "POST") return jsonResponse2(405, { ok: false, error: "method-not-allowed" });
    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse2(400, { ok: false, error: "\u8BF7\u6C42\u4F53\u4E0D\u662F\u5408\u6CD5 JSON" });
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return jsonResponse2(400, { ok: false, error: "\u8BF7\u6C42\u4F53\u4E0D\u662F JSON \u5BF9\u8C61" });
    }
    const record2 = body;
    const op = typeof record2.op === "string" ? record2.op : "";
    if (op === "create") {
      const result = await connectors.create(record2);
      return jsonResponse2(result.ok ? 200 : 400, result);
    }
    if (op === "remove") {
      const slug = typeof record2.slug === "string" ? record2.slug : "";
      if (slug === "") return jsonResponse2(400, { ok: false, error: "\u7F3A\u5C11 slug" });
      const result = await connectors.remove(slug);
      return jsonResponse2(result.ok ? 200 : 400, result);
    }
    if (op === "configure") {
      const id = typeof record2.id === "string" ? record2.id : "";
      if (id === "") return jsonResponse2(400, { ok: false, error: "\u7F3A\u5C11 id" });
      const { op: _op, id: _id, ...values } = record2;
      const result = await connectors.configure(id, values);
      return jsonResponse2(result.ok ? 200 : 400, result);
    }
    return jsonResponse2(400, { ok: false, error: `\u672A\u77E5 op\uFF1A${op}\uFF08\u5E94\u4E3A create / remove / configure\uFF09` });
  };
}

// apps/fom-client/plugins/office-console/connector-service.ts
import { join as join6 } from "node:path";

// apps/fom-client/plugins/office-catalog/local-catalog.ts
import { mkdirSync as mkdirSync3, readFileSync as readFileSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname } from "node:path";

// apps/fom-client/plugins/office-catalog/catalog.ts
var CATALOG_KINDS = ["skill", "expert", "connector"];
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

// apps/fom-client/plugins/office-catalog/local-catalog.ts
var LOCAL_CATALOG_FILE = "catalog.local.json";
var LOCAL_CATALOG_SCHEMA = 1;
var SOURCE_KINDS = ["bundle", "skill-provider", "mcp", "agent-preset"];
function asRecord3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function str(value) {
  return typeof value === "string" ? value : void 0;
}
function parseEntry(value) {
  const r = asRecord3(value);
  if (r === void 0) return "\u975E\u5BF9\u8C61";
  const id = str(r.id);
  const kind = str(r.kind);
  const name2 = str(r.name);
  if (id === void 0 || id === "") return "\u7F3A id";
  if (kind === void 0 || !CATALOG_KINDS.includes(kind)) return `kind \u975E\u6CD5\uFF1A${String(r.kind)}`;
  if (!id.startsWith(`${kind}:`)) return `id \u524D\u7F00\u4E0E kind \u4E0D\u7B26\uFF1A${id}`;
  if (name2 === void 0 || name2 === "") return "\u7F3A name";
  const source = asRecord3(r.source);
  const sourceKind = str(source?.kind);
  const tags = Array.isArray(r.tags) ? r.tags.filter((t) => typeof t === "string") : [];
  const spec = asRecord3(r.spec);
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
    tags,
    // spec 只在真是对象时才落（避免把 null/数组/字符串写进条目）；缺省不设该键
    ...spec === void 0 ? {} : { spec }
  };
}
function parseLocalCatalog(value) {
  const problems = [];
  const entries = [];
  const root = asRecord3(value);
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
    text = readFileSync3(path, "utf8");
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
  mkdirSync3(dirname(path), { recursive: true });
  const body = entries.map((entry) => ({ ...entry, origin: "local" }));
  writeFileSync3(path, `${JSON.stringify({ schemaVersion: LOCAL_CATALOG_SCHEMA, entries: body }, void 0, 2)}
`);
}

// apps/fom-client/plugins/office-console/connector-form.ts
function defaultsOf(form) {
  const out = {};
  for (const field of form) {
    if (field.default !== void 0) out[field.key] = field.default;
  }
  return out;
}
function isEmptyValue(value) {
  if (value === void 0 || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "object") return Object.keys(value).length === 0;
  return false;
}
function missingRequired(form, values) {
  const out = [];
  for (const field of form) {
    if (field.required !== true || field.type === "boolean" || field.type === "select") continue;
    if (isEmptyValue(values[field.key])) out.push(field.label);
  }
  return out;
}
function splitFormValues(form, values) {
  const config = {};
  const secrets = [];
  for (const field of form) {
    const raw = values[field.key];
    if (field.type === "boolean") {
      config[field.key] = raw === true;
      continue;
    }
    if (field.type === "list") {
      const items = Array.isArray(raw) ? raw.filter((item) => typeof item === "string").map((item) => item.trim()).filter((item) => item !== "") : typeof raw === "string" ? raw.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== "") : [];
      if (items.length > 0 || field.required === true) config[field.key] = items;
      continue;
    }
    if (field.type === "keyvalue") {
      const pairs = {};
      if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
        for (const [key, value] of Object.entries(raw)) {
          if (key.trim() === "") continue;
          if (typeof value !== "string") continue;
          pairs[key.trim()] = value.trim();
        }
      }
      if (Object.keys(pairs).length > 0 || field.required === true) config[field.key] = pairs;
      continue;
    }
    const text = typeof raw === "string" ? raw.trim() : "";
    if (field.storeAs !== void 0 && field.storeAs !== "") {
      if (text !== "") secrets.push({ ref: field.storeAs, value: text });
      continue;
    }
    if (text === "" && field.required !== true && field.type !== "select") continue;
    config[field.key] = text;
  }
  return { config, secrets };
}

// apps/fom-client/plugins/office-console/connector-bundle.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync4, readFileSync as readFileSync4, rmSync as rmSync3, writeFileSync as writeFileSync4 } from "node:fs";
import { homedir } from "node:os";
import { join as join3 } from "node:path";

// apps/fom-client/plugins/office-console/mcp-form.ts
var SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
var MCP_TRANSPORTS = ["stdio", "streamable-http"];
var DEFAULT_TOOL_CALL_TIMEOUT_MS = 6e4;
function isValidServerName(name2) {
  return SERVER_NAME_PATTERN.test(name2);
}
function serverNameProblem(name2) {
  if (name2 === "") return "\u8BF7\u586B\u5199\u670D\u52A1\u540D";
  if (name2.length > 32) return "\u670D\u52A1\u540D\u6700\u957F 32 \u5B57\u7B26";
  if (!isValidServerName(name2)) return "\u670D\u52A1\u540D\u53EA\u80FD\u7528\u5B57\u6BCD\u3001\u6570\u5B57\u3001\u4E0B\u5212\u7EBF\u4E0E\u8FDE\u5B57\u7B26\uFF08\u5B83\u662F\u5DE5\u5177\u540D\u524D\u7F00 mcp__<\u670D\u52A1\u540D>__<\u5DE5\u5177>\uFF09";
  return void 0;
}
function transportField() {
  return {
    key: "transport",
    label: "\u4F20\u8F93\u7C7B\u578B",
    type: "select",
    required: true,
    options: [
      { value: "stdio", label: "stdio\uFF08\u672C\u5730\u547D\u4EE4\uFF09" },
      { value: "streamable-http", label: "streamable-http\uFF08HTTP \u670D\u52A1\uFF09" }
    ],
    hint: "\u51B3\u5B9A\u540E\u9762\u51FA\u73B0\u54EA\u4E9B\u5B57\u6BB5\uFF1B\u5E73\u53F0\u4E0B\u53D1\u7684\u8FDE\u63A5\u5668\u6309\u76EE\u5F55\u58F0\u660E\uFF0C\u4E0D\u53EF\u6539"
  };
}
function timeoutField() {
  return {
    key: "toolCallTimeoutMs",
    label: "\u5355\u6B21\u8C03\u7528\u8D85\u65F6\uFF08\u6BEB\u79D2\uFF0C\u53EF\u9009\uFF09",
    type: "text",
    default: String(DEFAULT_TOOL_CALL_TIMEOUT_MS),
    hint: "\u7559\u7A7A\u7528\u9ED8\u8BA4 60000\uFF1B\u6CA1\u6709 1000 \u4E0B\u9650\uFF08\u90A3\u662F\u522B\u7684\u4EA7\u54C1\u7684\u89C4\u5219\uFF09"
  };
}
function serverNameField(required) {
  return {
    key: "serverName",
    label: "\u670D\u52A1\u540D",
    type: "text",
    required,
    placeholder: "github-search",
    hint: "\u53EA\u80FD\u7528\u5B57\u6BCD\u6570\u5B57 _- \uFF0C\u6700\u957F 32\uFF1B\u5B83\u51B3\u5B9A\u5DE5\u5177\u540D\u524D\u7F00 mcp__<\u670D\u52A1\u540D>__<\u5DE5\u5177>\uFF0C\u540C\u673A\u4E0D\u53EF\u91CD\u540D"
  };
}
function mcpConfigForm(transport, options = {}) {
  const fields = [];
  if (options.includeTransport === true) fields.push(transportField());
  fields.push(serverNameField(true));
  if (transport === "stdio") {
    fields.push({
      key: "command",
      label: "\u547D\u4EE4",
      type: "text",
      required: true,
      placeholder: "npx",
      hint: "\u542F\u52A8 MCP server \u7684\u53EF\u6267\u884C\u6587\u4EF6\uFF0C\u4F8B\u5982 npx / python / node"
    });
    fields.push({
      key: "args",
      label: "\u53C2\u6570\uFF08\u6BCF\u884C\u4E00\u4E2A\uFF09",
      type: "list",
      hint: "\u4F8B\u5982 -y \u4E0E @modelcontextprotocol/server-everything \u5404\u5360\u4E00\u884C"
    });
    fields.push({
      key: "env",
      label: "\u73AF\u5883\u53D8\u91CF",
      type: "keyvalue",
      secretValues: true,
      hint: "\u952E\u503C\u5BF9\uFF1B\u503C\u4F1A\u5199\u8FDB\u672C\u673A patch \u6587\u4EF6\uFF0C\u654F\u611F\u503C\u8BF7\u6539\u7528 JSON \u6A21\u5F0F\u5199 !!js process.env.<\u53D8\u91CF\u540D>"
    });
    fields.push({
      key: "cwd",
      label: "\u5DE5\u4F5C\u76EE\u5F55\uFF08\u53EF\u9009\uFF09",
      type: "text",
      placeholder: "D:\\tools\\my-mcp",
      hint: "\u53EA\u63A5\u53D7\u7EDD\u5BF9\u8DEF\u5F84\uFF1B\u7559\u7A7A\u7528\u5F53\u524D\u5DE5\u4F5C\u76EE\u5F55"
    });
    fields.push(timeoutField());
    return fields;
  }
  if (transport === "streamable-http") {
    fields.push({
      key: "url",
      label: "\u670D\u52A1\u5730\u5740",
      type: "text",
      required: true,
      placeholder: "https://example.com/mcp",
      hint: "\u652F\u6301 HTTP \u6216 HTTPS\uFF1B\u4E0D\u8981\u5728 URL \u4E2D\u653E token \u6216\u5BC6\u7801"
    });
    fields.push({
      key: "headers",
      label: "\u8BF7\u6C42\u5934",
      type: "keyvalue",
      secretValues: true,
      hint: "\u952E\u503C\u5BF9\uFF1B\u503C\u4F1A\u5199\u8FDB\u672C\u673A patch \u6587\u4EF6\uFF0C\u654F\u611F\u503C\u8BF7\u6539\u7528 JSON \u6A21\u5F0F\u5199 !!js process.env.<\u53D8\u91CF\u540D>"
    });
    fields.push(timeoutField());
    return fields;
  }
  fields.push(timeoutField());
  return fields;
}
function transportOfSpec(spec) {
  const value = spec?.transport;
  return typeof value === "string" && value !== "" ? value : void 0;
}

// apps/fom-client/plugins/office-console/connector-bundle.ts
var CONNECTORS_DIR = "connectors";
var LOCAL_SCOPE = "@local";
var MCP_CLIENT_PLUGIN = "@deepseek-ai/dsh-mcp-client";
var NUMERIC_KEYS = ["toolCallTimeoutMs", "maxInstructionBytes"];
function connectorsRoot(home) {
  const base = home ?? (process.env.DSH_HOME !== void 0 && process.env.DSH_HOME !== "" ? process.env.DSH_HOME : join3(homedir(), ".dsh"));
  return join3(base, "office", CONNECTORS_DIR);
}
function connectorDir(root, slug) {
  return join3(root, slug);
}
function isValidConnectorSlug(slug) {
  return isValidSkillSlug(slug);
}
function yamlScalar(value) {
  const needsQuote = value === "" || /^[-+]?\d+(\.\d+)?$/u.test(value) || /^(true|false|yes|no|on|off|null|~)$/iu.test(value) || /^\s|\s$/u.test(value) || /:\s|\s#|:$/u.test(value) || /[,\{}\[\]]/u.test(value) || /^[-?!&*|>%@`"']/u.test(value);
  if (!needsQuote) return value;
  return `'${value.replace(/'/gu, "''")}'`;
}
function yamlValue(key, value) {
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    const items = value.filter((item) => typeof item === "string");
    if (items.length === 0) return "[]";
    return `[${items.map((item) => yamlScalar(item)).join(", ")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const pairs = Object.entries(value).filter(([, v]) => typeof v === "string").map(([k, v]) => `${k}: ${yamlScalar(v)}`);
    return pairs.length === 0 ? "{}" : `{${pairs.join(", ")}}`;
  }
  const text = typeof value === "string" ? value : String(value);
  return NUMERIC_KEYS.includes(key) && /^\d+$/u.test(text) ? text : yamlScalar(text);
}
function renderBundlePatch(spec) {
  const config = {
    serverName: spec.serverName,
    transport: spec.transport,
    ...spec.config
  };
  const lines = [
    "- insert:",
    `    - id: ${spec.slug}`,
    `      name: '${MCP_CLIENT_PLUGIN}'`,
    "      config:"
  ];
  for (const [key, value] of Object.entries(config)) {
    if (value === void 0) continue;
    lines.push(`        ${key}: ${yamlValue(key, value)}`);
  }
  return `${lines.join("\n")}
`;
}
function renderBundlePackageJson(slug) {
  return `${JSON.stringify({
    name: `${LOCAL_SCOPE}/${slug}`,
    version: "1.0.0",
    private: true,
    type: "module",
    exports: { "./locale/*.json": "./locale/*.json" },
    files: ["cordis.patch.yml", "locale/*.json"],
    dsh: { bundle: { patch: "./cordis.patch.yml" } }
  }, void 0, 2)}
`;
}
function renderLocaleEn(name2) {
  return `${JSON.stringify({ name: name2 }, void 0, 2)}
`;
}
function writeConnectorBundle(root, spec) {
  if (!isValidConnectorSlug(spec.slug)) throw new Error(`\u975E\u6CD5\u8FDE\u63A5\u5668 slug\uFF1A${spec.slug}`);
  if (!MCP_TRANSPORTS.includes(spec.transport)) {
    throw new Error(`\u4E0D\u652F\u6301\u7684\u4F20\u8F93\u7C7B\u578B\uFF1A${spec.transport}\uFF08\u5185\u6838\u53EA\u8BA4 ${MCP_TRANSPORTS.join(" / ")}\uFF09`);
  }
  const dir = connectorDir(root, spec.slug);
  mkdirSync4(join3(dir, "locale"), { recursive: true });
  const configPath = join3(dir, "config.json");
  const patchPath = join3(dir, "cordis.patch.yml");
  const body = {
    slug: spec.slug,
    name: spec.name,
    description: spec.description,
    serverName: spec.serverName,
    transport: spec.transport,
    ...spec.config
  };
  writeFileSync4(configPath, `${JSON.stringify(body, void 0, 2)}
`);
  writeFileSync4(patchPath, renderBundlePatch(spec));
  writeFileSync4(join3(dir, "package.json"), renderBundlePackageJson(spec.slug));
  writeFileSync4(join3(dir, "locale", "en.json"), renderLocaleEn(spec.name));
  return { dir, config: configPath, patch: patchPath };
}
function removeConnectorBundle(root, slug) {
  const dir = connectorDir(root, slug);
  if (!existsSync3(dir)) return false;
  rmSync3(dir, { recursive: true, force: true });
  return true;
}
function readConnectorConfig(root, slug) {
  try {
    const parsed = JSON.parse(readFileSync4(join3(connectorDir(root, slug), "config.json"), "utf8"));
    const { slug: s, name: name2, description, serverName, transport, ...rest } = parsed;
    if (typeof s !== "string" || typeof serverName !== "string" || typeof transport !== "string") return void 0;
    return {
      slug: s,
      name: typeof name2 === "string" ? name2 : s,
      description: typeof description === "string" ? description : "",
      serverName,
      transport,
      config: rest
    };
  } catch {
    return void 0;
  }
}
function localConnectorEntry(spec) {
  return {
    id: `connector:${spec.slug}`,
    kind: "connector",
    name: spec.name,
    description: spec.description,
    version: "0.1.0",
    category: "\u81EA\u5EFA",
    origin: "local",
    defaultEnabled: true,
    source: { kind: "mcp", ref: spec.slug },
    tags: [],
    spec: { transport: spec.transport, serverName: spec.serverName }
  };
}

// apps/fom-client/plugins/office-console/persist.ts
import { mkdirSync as mkdirSync5, readFileSync as readFileSync5, writeFileSync as writeFileSync5 } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname2, join as join4 } from "node:path";
function readJsonFile(path) {
  try {
    return JSON.parse(readFileSync5(path, "utf8"));
  } catch {
    return void 0;
  }
}
function writeJsonFile(path, value) {
  mkdirSync5(dirname2(path), { recursive: true });
  writeFileSync5(path, `${JSON.stringify(value, void 0, 2)}
`);
}
function resolveDshHome() {
  const home = process.env.DSH_HOME;
  return home !== void 0 && home !== "" ? home : join4(homedir2(), ".dsh");
}
function consoleStateDir(home = resolveDshHome()) {
  return join4(home, "office");
}

// apps/fom-client/plugins/office-console/profile-patch.ts
import { existsSync as existsSync4, mkdirSync as mkdirSync6, readFileSync as readFileSync6, writeFileSync as writeFileSync6 } from "node:fs";
import { dirname as dirname3, join as join5 } from "node:path";
function yamlScalar2(value) {
  const needsQuote = value === "" || /^[-+]?\d+(\.\d+)?$/u.test(value) || /^(true|false|yes|no|on|off|null|~)$/iu.test(value) || /^\s|\s$/u.test(value) || /:\s|\s#|:$/u.test(value) || /[,\{}\[\]]/u.test(value) || /^[-?!&*|>%@`"']/u.test(value);
  if (!needsQuote) return value;
  return `'${value.replace(/'/gu, "''")}'`;
}
function yamlValue2(key, value) {
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) {
    const items = value.filter((item) => typeof item === "string");
    return items.length === 0 ? "[]" : `[${items.map(yamlScalar2).join(", ")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const pairs = Object.entries(value).filter(([, v]) => typeof v === "string").map(([k, v]) => `${k}: ${yamlScalar2(v)}`);
    return pairs.length === 0 ? "{}" : `{${pairs.join(", ")}}`;
  }
  const text = typeof value === "string" ? value : String(value);
  return /^\d+$/u.test(text) && (key === "toolCallTimeoutMs" || key === "maxInstructionBytes") ? text : yamlScalar2(text);
}
function renderPatchEntry(id, name2, config) {
  const lines = [`- id: ${id}`, `  name: '${name2}'`, "  config:"];
  for (const [key, value] of Object.entries(config)) {
    if (value === void 0) continue;
    lines.push(`    ${key}: ${yamlValue2(key, value)}`);
  }
  return `${lines.join("\n")}
`;
}
function findEntrySpan(text, id) {
  const lines = text.split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const m = /^- id:\s*'?([^'\s]+)'?\s*$/u.exec(line);
    if (m === null) continue;
    if (start >= 0) return { start, end: i };
    if (m[1] === id) start = i;
  }
  return start >= 0 ? { start, end: lines.length } : void 0;
}
function countEntries(text) {
  return text.split("\n").filter((line) => /^- id:\s*'?[^'\s]+'?\s*$/u.test(line)).length;
}
function upsertPatchEntry(text, id, entry) {
  const before = countEntries(text);
  const span = findEntrySpan(text, id);
  const lines = text.split("\n");
  let next;
  if (span === void 0) {
    const trimmed = text.replace(/\s+$/u, "");
    next = trimmed === "" ? [entry.trimEnd()] : [`${trimmed}`, "", entry.trimEnd(), ""];
  } else {
    const entryLines = entry.trimEnd().split("\n");
    next = [...lines.slice(0, span.start), ...entryLines, ...lines.slice(span.end)];
  }
  const result = next.join("\n");
  if (countEntries(result) < before) {
    throw new Error(`patch \u624B\u672F\u5F02\u5E38\uFF1A\u6761\u76EE\u6570 ${before} \u2192 ${countEntries(result)}\uFF08\u7591\u4F3C\u8BEF\u5224\u8FB9\u754C\uFF0C\u5DF2\u653E\u5F03\u5199\u5165\uFF09`);
  }
  return result;
}
function profilePatchPath(home, profile = "desktop") {
  return join5(home, "profiles", profile, "cordis.patch.yml");
}
function readProfilePatch(path) {
  if (!existsSync4(path)) return "";
  return readFileSync6(path, "utf8");
}
function writeProfilePatch(path, text) {
  mkdirSync6(dirname3(path), { recursive: true });
  writeFileSync6(path, text);
}

// apps/fom-client/plugins/office-feishu/config-form.ts
var configForm = [
  {
    key: "feishuAppId",
    label: "App ID",
    type: "text",
    required: true,
    placeholder: "cli_xxxxxxxxxxxxxxxx",
    hint: "\u98DE\u4E66\u5F00\u653E\u5E73\u53F0 \u2192 \u5E94\u7528\u8BE6\u60C5 \u2192 \u51ED\u8BC1\u4E0E\u57FA\u7840\u4FE1\u606F"
  },
  {
    key: "feishuAppSecret",
    label: "App Secret",
    type: "secret",
    required: true,
    storeAs: "FOM_FEISHU_APP_SECRET",
    hint: "\u540C\u4E0A\uFF1B\u4EC5\u4FDD\u5B58\u5728\u672C\u673A\u51ED\u636E\u5E93\uFF0C\u914D\u7F6E\u6587\u4EF6\u91CC\u53EA\u7559\u5F15\u7528\u540D"
  },
  {
    key: "readOnly",
    label: "\u53EA\u8BFB\u6A21\u5F0F",
    type: "boolean",
    default: false,
    hint: "\u5F00\u542F\u540E\u53EA\u6CE8\u518C\u8BFB\u5DE5\u5177\uFF08\u6587\u6863 / \u591A\u7EF4\u8868\u683C / \u65E5\u5386\uFF09\uFF0C\u5199\u5DE5\u5177\u4E0D\u6CE8\u518C"
  },
  {
    key: "baseUrl",
    label: "\u4F20\u8F93\u57FA\u5740",
    type: "text",
    default: "https://open.feishu.cn",
    hint: "\u6D4B\u8BD5\u6216\u81EA\u5EFA\u4EE3\u7406\u624D\u9700\u8981\u6539\uFF1B\u4E00\u822C\u4FDD\u6301\u9ED8\u8BA4"
  }
];

// apps/fom-client/plugins/office-console/connector-service.ts
function bundleName(slug) {
  return `@local/${slug}`;
}
function indexPath(home) {
  return join6(consoleStateDir(home ?? resolveDshHome()), LOCAL_CATALOG_FILE);
}
var PLUGIN_FORMS = {
  "connector:feishu": configForm
};
function readPatchEntryConfig(text, id) {
  const span = findEntrySpan(text, id);
  if (span === void 0) return void 0;
  const lines = text.split("\n").slice(span.start, span.end);
  const config = {};
  let inConfig = false;
  for (const line of lines) {
    if (/^ {2}config:\s*$/u.test(line)) {
      inConfig = true;
      continue;
    }
    if (!inConfig) continue;
    if (/^ {2}\S/u.test(line) && !/^ {4}\S/u.test(line)) break;
    const m = /^ {4}(\S+):\s*(.*)$/u.exec(line);
    if (m === null) continue;
    const value = (m[2] ?? "").trim();
    if (value === "" || value === "''") {
      config[m[1]] = "";
      continue;
    }
    if (value === "true") {
      config[m[1]] = true;
      continue;
    }
    if (value === "false") {
      config[m[1]] = false;
      continue;
    }
    if (/^-?\d+(\.\d+)?$/u.test(value)) {
      config[m[1]] = Number(value);
      continue;
    }
    config[m[1]] = value.replace(/^'|'$/gu, "").replace(/''/gu, "'");
  }
  return config;
}
function createConnectorService(deps = {}) {
  const root = connectorsRoot(deps.home);
  const upsertIndex = (entry) => {
    const path = indexPath(deps.home);
    const current = readLocalCatalog(path).filter((item) => item.id !== entry.id);
    writeLocalCatalog(path, [...current, entry]);
  };
  const dropIndex = (id) => {
    const path = indexPath(deps.home);
    const current = readLocalCatalog(path);
    if (!current.some((item) => item.id === id)) return;
    writeLocalCatalog(path, current.filter((item) => item.id !== id));
  };
  return {
    async create(input) {
      const slug = String(input.slug ?? "").trim();
      if (!isValidSkillSlug(slug)) {
        return { ok: false, error: `\u975E\u6CD5\u8FDE\u63A5\u5668 slug\uFF1A${String(input.slug ?? "")}\uFF08\u5C0F\u5199\u5B57\u6BCD\u6570\u5B57\u5F00\u5934\uFF0C\u53EA\u5141\u8BB8 . _ -\uFF09` };
      }
      const transport = typeof input.transport === "string" ? input.transport.trim() : "";
      if (transport === "") return { ok: false, error: "\u8BF7\u9009\u62E9\u4F20\u8F93\u7C7B\u578B" };
      const form = mcpConfigForm(transport);
      const missing = missingRequired(form, input);
      if (missing.length > 0) return { ok: false, error: `\u8BF7\u586B\u5199\uFF1A${missing.join("\u3001")}`, missing };
      const serverName = typeof input.serverName === "string" ? input.serverName.trim() : "";
      const problem = serverNameProblem(serverName);
      if (problem !== void 0) return { ok: false, error: problem };
      const name2 = String(input.name ?? "").trim();
      const description = String(input.description ?? "").trim();
      if (name2 === "") return { ok: false, error: "\u8BF7\u586B\u5199\u8FDE\u63A5\u5668\u540D\u79F0" };
      const { config } = splitFormValues(form, input);
      const spec = {
        slug,
        name: name2,
        description,
        serverName,
        transport,
        config: { ...config, transport }
      };
      try {
        writeConnectorBundle(root, spec);
        upsertIndex(localConnectorEntry(spec));
      } catch (error) {
        return { ok: false, error: `\u5199\u5165\u672C\u5730\u8FDE\u63A5\u5668\u5931\u8D25\uFF1A${String(error?.message ?? error)}` };
      }
      if (deps.installer === void 0) {
        return { ok: true, slug, dryRun: true };
      }
      try {
        const installed = await deps.installer.installBundle(bundleName(slug));
        return { ok: true, slug, dryRun: false, installed };
      } catch (error) {
        return {
          ok: false,
          slug,
          error: `\u672C\u5730\u6587\u4EF6\u5DF2\u5199\u597D\uFF0C\u4F46\u5B89\u88C5\u5931\u8D25\uFF1A${String(error?.message ?? error)}`
        };
      }
    },
    async remove(slug) {
      const clean = slug.trim();
      if (!isValidSkillSlug(clean)) return { ok: false, error: `\u975E\u6CD5\u8FDE\u63A5\u5668 slug\uFF1A${slug}` };
      const existed = readConnectorConfig(root, clean) !== void 0;
      if (deps.installer === void 0) {
        removeConnectorBundle(root, clean);
        dropIndex(`connector:${clean}`);
        return { ok: true, slug: clean, dryRun: true, removed: existed };
      }
      try {
        await deps.installer.removeBundle(bundleName(clean));
      } catch (error) {
        return { ok: false, slug: clean, error: `\u5378\u8F7D\u5931\u8D25\uFF1A${String(error?.message ?? error)}` };
      }
      removeConnectorBundle(root, clean);
      dropIndex(`connector:${clean}`);
      return { ok: true, slug: clean, dryRun: false, removed: existed };
    },
    configOf(slug) {
      const clean = slug.trim();
      const spec = readConnectorConfig(root, clean);
      if (spec !== void 0) {
        const form = mcpConfigForm(transportOfSpec({ transport: spec.transport }));
        const values2 = { ...defaultsOf(form), ...spec.config, serverName: spec.serverName, transport: spec.transport };
        for (const field of form) {
          if (field.secretValues !== true) continue;
          const current2 = values2[field.key];
          if (typeof current2 === "object" && current2 !== null && !Array.isArray(current2)) {
            const keys = Object.keys(current2);
            values2[field.key] = keys.length === 0 ? {} : Object.fromEntries(keys.map((k) => [k, "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"]));
          }
        }
        return { slug: clean, form, values: values2, installed: deps.installer !== void 0 };
      }
      const pluginForm = PLUGIN_FORMS[clean];
      if (pluginForm === void 0) return void 0;
      const patchText = readProfilePatch(profilePatchPath(deps.home ?? resolveDshHome(), deps.profile));
      const entryId = clean.replace(/^connector:/u, "");
      const current = readPatchEntryConfig(patchText, entryId) ?? {};
      const values = { ...defaultsOf(pluginForm), ...current };
      for (const field of pluginForm) {
        if (field.storeAs === void 0 || field.storeAs === "") continue;
        values[field.key] = deps.credentials !== void 0 ? "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022" : "";
      }
      return { slug: clean, form: pluginForm, values, installed: true };
    },
    async configure(id, values) {
      const clean = id.trim();
      const form = PLUGIN_FORMS[clean];
      if (form === void 0) {
        return { ok: false, error: `\u8BE5\u8FDE\u63A5\u5668\u4E0D\u652F\u6301\u914D\u7F6E\uFF1A${id}\uFF08\u5F53\u524D\u53EA\u6709 ${Object.keys(PLUGIN_FORMS).join("\u3001")}\uFF09` };
      }
      const missing = missingRequired(form, values);
      if (missing.length > 0) return { ok: false, error: `\u8BF7\u586B\u5199\uFF1A${missing.join("\u3001")}`, missing };
      const { config, secrets } = splitFormValues(form, values);
      const entryId = clean.replace(/^connector:/u, "");
      const pluginName = entryId === "feishu" ? "@office/feishu" : `@office/${entryId}`;
      const written = [];
      if (deps.credentials !== void 0) {
        for (const secret of secrets) {
          try {
            await deps.credentials.set(secret.ref, secret.value);
            written.push(secret.ref);
          } catch (error) {
            return { ok: false, error: `\u5199\u5165\u51ED\u636E\u5E93\u5931\u8D25\uFF08${secret.ref}\uFF09\uFF1A${String(error?.message ?? error)}` };
          }
        }
      } else if (secrets.length > 0) {
        return {
          ok: false,
          error: "\u672C\u673A\u672A\u63D0\u4F9B\u51ED\u636E\u5E93\u5199\u5165\u53E3\uFF0CApp Secret \u65E0\u6CD5\u5B89\u5168\u4FDD\u5B58\uFF1B\u8BF7\u6539\u7528 JSON \u6A21\u5F0F\u5199 !!js process.env.<\u53D8\u91CF\u540D>"
        };
      }
      try {
        const path = profilePatchPath(deps.home ?? resolveDshHome(), deps.profile);
        const next = upsertPatchEntry(readProfilePatch(path), entryId, renderPatchEntry(entryId, pluginName, config));
        writeProfilePatch(path, next);
      } catch (error) {
        return { ok: false, error: `\u5199\u5165 profile patch \u5931\u8D25\uFF1A${String(error?.message ?? error)}` };
      }
      return { ok: true, id: clean, secretsWritten: written, restartRequired: true };
    },
    createForm(transport) {
      const form = mcpConfigForm(transport, { includeTransport: true });
      return { form, values: defaultsOf(form) };
    },
    list() {
      const entries = readLocalCatalog(indexPath(deps.home)).filter((item) => item.kind === "connector");
      return entries.map((entry) => readConnectorConfig(root, entry.id.replace(/^connector:/u, ""))).filter((spec) => spec !== void 0);
    }
  };
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
  const enabledPath = join7(stateDir, "console-enabled.json");
  const approvalsPath = join7(stateDir, "console-approvals.json");
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
  const connectorInstaller = config.enableInstaller === true ? createConnectorInstaller((() => {
    const pm = ctx.get("pluginManager");
    if (pm === void 0) throw new Error("office-console: enableInstaller \u5DF2\u5F00\u4F46 pluginManager \u670D\u52A1\u7F3A\u5931");
    return pm;
  })()) : void 0;
  const executor = createConsoleExecutor({
    store,
    approvals,
    skills: {
      create: (spec) => {
        const path = writeManagedSkill(join7(resolveDshHome(), "office", MANAGED_SKILLS_DIR), spec);
        ctx.get("officeSkills")?.refresh();
        return path;
      },
      remove: (slug) => {
        const removed = removeManagedSkill(join7(resolveDshHome(), "office", MANAGED_SKILLS_DIR), slug);
        ctx.get("officeSkills")?.refresh();
        return removed;
      },
      read: (slug) => {
        const raw = readManagedSkill(join7(resolveDshHome(), "office", MANAGED_SKILLS_DIR), slug);
        if (raw === void 0) return void 0;
        const front = parseSkillFrontmatter(raw);
        return { slug, name: front.name ?? slug, description: front.description ?? "", body: skillBody(raw) };
      }
    },
    experts: {
      create: (spec) => {
        const service = ctx.get("officeExperts");
        return service !== void 0 ? service.create(spec) : Promise.resolve(writeExpertDelta(join7(resolveDshHome(), "office", EXPERT_PRESETS_DIR), spec));
      },
      remove: (id) => {
        const service = ctx.get("officeExperts");
        return service !== void 0 ? service.remove(id) : removeExpertDelta(join7(resolveDshHome(), "office", EXPERT_PRESETS_DIR), id);
      },
      read: (id) => readExpertDelta(join7(resolveDshHome(), "office", EXPERT_PRESETS_DIR), id)
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
      const connectors = createConnectorService(
        connectorInstaller !== void 0 ? { installer: connectorInstaller } : {}
      );
      const disposeConnectors = conn.fetch.register({
        path: CONNECTOR_ROUTE,
        methods: ["GET", "POST"],
        requestBody: "buffered",
        fetch: createConnectorFetch(authz, operatorRole, connectors)
      });
      return () => {
        void disposeConnectors();
        void dispose();
      };
    }, "office-console: \u5199\u7AEF\u70B9\uFF08\u8BA4\u8BC1 Fetch \u8DEF\u7531\uFF09+ \u7528\u6237\u81EA\u5EFA\u8FDE\u63A5\u5668");
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
  createConnectorInstaller,
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

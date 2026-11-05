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
var OfficeAuthzError = class extends Error {
  code;
  constructor(code, message) {
    super(message);
    this.name = "OfficeAuthzError";
    this.code = code;
  }
};
function can(role, action) {
  const policy = ACTION_POLICY[action];
  return policy !== void 0 && policy.allow.includes(role);
}
function requiresApproval(action) {
  const policy = ACTION_POLICY[action];
  return policy === void 0 ? true : policy.requiresApproval;
}
function assertCan(role, action) {
  if (!can(role, action)) {
    throw new OfficeAuthzError("office-authz/forbidden", `\u89D2\u8272 ${role} \u4E0D\u5141\u8BB8\u52A8\u4F5C ${action}`);
  }
}
function validatePolicy() {
  const problems = [];
  for (const action of OFFICE_ACTIONS) {
    const policy = ACTION_POLICY[action];
    if (policy === void 0) {
      problems.push(`\u52A8\u4F5C\u7F3A\u7B56\u7565\uFF1A${action}`);
      continue;
    }
    if (policy.allow.length === 0) problems.push(`\u52A8\u4F5C\u65E0\u5141\u8BB8\u89D2\u8272\uFF1A${action}`);
    for (const role of policy.allow) {
      if (!OFFICE_ROLES.includes(role)) problems.push(`\u52A8\u4F5C ${action} \u542B\u672A\u77E5\u89D2\u8272 ${role}`);
    }
    if (policy.requiresApproval && policy.allow.includes("guest")) {
      problems.push(`\u9AD8\u5371\u52A8\u4F5C\u4E0D\u5141\u8BB8 guest\uFF1A${action}`);
    }
  }
  for (const action of Object.keys(ACTION_POLICY)) {
    if (!OFFICE_ACTIONS.includes(action)) problems.push(`\u7B56\u7565\u542B\u672A\u767B\u8BB0\u52A8\u4F5C\uFF1A${action}`);
  }
  return problems;
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

// apps/fom-client/plugins/office-authz/index.ts
var name = "office-authz";
function createAuthzService() {
  return { can, requiresApproval, assertCan };
}
function apply(ctx) {
  const service = createAuthzService();
  ctx.effect(() => ctx.reflect.provide("officeAuthz", service));
}
var index_default = { name, apply };
export {
  ACTION_POLICY,
  OFFICE_ACTIONS,
  OFFICE_ROLES,
  OfficeAuthzError,
  apply,
  assertCan,
  can,
  createAuthzService,
  index_default as default,
  name,
  requiresApproval,
  runConsoleAction,
  validatePolicy
};

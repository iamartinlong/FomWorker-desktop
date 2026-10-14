const fs = require('fs');
const path = require('path');

const kernel = 'F:/deepseek/deepseek harness/deepseek-harness';
const srcFile = path.join(kernel, 'packages/bundle/web-app/presets/standard.patch.yml');
const outFile = path.join('F:/deepseek/deepseek harness/office-platform', 'session-query.spike.patch.yml');

const lines = fs.readFileSync(srcFile, 'utf8').split(/\r?\n/);

// 1) rename the copied roster row's id so it can coexist with the disabled shipped one
const idLine = lines.findIndex(l => l === '    - id: preset-standard');
if (idLine < 0) throw new Error('anchor "    - id: preset-standard" not found');
lines[idLine] = '    - id: preset-standard-office';

// 2) splice the tool row into the roster, before skill-filesystem
const anchor = lines.findIndex(l => l === '          - id: skill-filesystem');
if (anchor < 0) throw new Error('anchor "          - id: skill-filesystem" not found');
lines.splice(anchor, 0,
  "          - id: tool-session-query",
  "            name: '@deepseek-ai/dsh-tool-session-query'",
);

// 3) drop the kernel's own header comment and its `- insert:` opener (we re-open below)
const insertOpener = lines.findIndex(l => l === '- insert:');
if (insertOpener < 0) throw new Error('no "- insert:" opener');
const roster = lines.slice(insertOpener + 1).join('\n').replace(/\n+$/, '\n');

const header = `# 记忆层 §7 第 1 步 spike：打开内核已有的 FTS5 跨会话检索，并挂上五把模型工具
#
# 用法（在仓库根目录执行；--patch 必须排在 --port 这类应用旗标之前）：
#   pnpm dsh web --patch ../office-platform/session-query.spike.patch.yml --port 3090
#
# 两条实测到源码级的事实（写这份 patch 前我以为要 insert 后端包，其实不用）：
#   1) \`session-query-sqlite\` **已经在发行的组合里挂着**（packages/bundle/base/cordis.patch.yml:149-152），
#      只是 config 是 \`path: ':memory:', openAt: never\` —— 内核注释原文：
#      "Full-text session search is opt-in ... Deployments enabling content search override
#       \`openAt\` to \`first-search\` or \`startup\` in a later patch layer, typically with a durable \`path\`."
#      ⇒ 启用是**覆盖 config**，不是新增组件（覆盖行整段替换 config，所以 \`path\` 必须一起重抄）。
#   2) 五把模型工具（\`dsh-tool-session-query\`）在**任何**发行 profile 里都没有组件行
#      （全仓 grep \`tool-session-query\` 在 packages/bundle 与 apps 下零命中），
#      而 web 层把 base 的进程级 tool-* 行全部 disable、改由 presets/*.patch.yml 的**名录**按 agent 挂载
#      （packages/bundle/web-app/cordis.patch.yml:487-491 禁用 tool-fs / tool-fs-search）。
#      ⇒ 正确落点是名录，所以本文件把内核的 \`standard\` 名录整行禁用、插一份逐字副本、只多一行 tool-session-query。
#      副本由 \`node .spike/make-session-query-patch.cjs\` 从内核文件文本拼接生成，别手抄。
#
# ⚠️ 名录按 id 匹配，只有选 standard 名录的会话拿得到这五把工具（minimal/ptc/cordis 名录没加）。
# ⚠️ 索引 path 的唯一所有者是**这个进程**：蒸馏进程第二个进程不得指向同一个 path（设计 ME4）。

- id: session-query-sqlite
  config:
    path: !!js dshHomePath('session-query/office-spike.db')
    openAt: first-search

- id: preset-standard
  disabled: true

- insert:
`;

fs.writeFileSync(outFile, header + roster, 'utf8');
console.log('written:', outFile);
const out = fs.readFileSync(outFile, 'utf8').split(/\r?\n/);
console.log('total lines:', out.length);
const at = out.findIndex(l => l.includes('tool-session-query') && l.trim().startsWith('- id:'));
console.log('--- roster head (first 6 roster lines) ---');
console.log(out.slice(out.length - 1 - 0, 0).join(''));
const rosterStart = out.findIndex(l => l === '- insert:');
console.log(out.slice(rosterStart, rosterStart + 8).join('\n'));
console.log('--- inserted region ---');
console.log(out.slice(at - 2, at + 5).join('\n'));

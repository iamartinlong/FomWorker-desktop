/**
 * 记忆层第 2 步的变异检验（设计 §8 V7：每条守卫至少被一处变异抓住）。
 *
 * 纪律照审批层那一次：一次只跑一份 harness、日志等进程退出后再读、变异期间不起产品。
 * 每个变异都是**独立**地应用到源码副本上，跑完立刻还原，所以任何一刻磁盘上都只有一份变异。
 *
 * 判据：该变异必须让至少一条用例变红。绿 = 那条守卫没被断言 = 测试是假的。
 *
 * 「抓住」的判定与上一轮同一个口径（`.spike/fe-mutation.mjs:3-6` 的教训）：vitest 给数字和符号
 * 上了 ANSI 色，带色读 stdout 会把没有守卫的代码说成有守卫 —— 所以先去色，再只按「这行有没有 `×`」判。
 */

import { execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = 'F:/deepseek/deepseek harness/apps/fom-client'
const STORE = join(ROOT, 'plugins/office-memory/store.ts')
const TOOLS = join(ROOT, 'plugins/office-memory/tools.ts')
const GATE = join(ROOT, 'plugins/office-approval/risk-gate.ts')
const INJECT = join(ROOT, 'plugins/office-memory/inject.ts')
const RECALL = join(ROOT, 'plugins/office-memory/recall.ts')

const MUTANTS = [
  {
    id: 'm1-symbolic-link',
    claim: '去掉「记忆路径逐级拒链接」——越权第三形',
    file: STORE,
    from: "      if (stat?.isSymbolicLink() === true) {",
    to: "      if (false && stat?.isSymbolicLink() === true) {",
  },
  {
    id: 'm2-secret-entry',
    claim: '去掉条目正文的凭据黑名单（ME7 写侧一半）',
    file: STORE,
    from: "    const signal = findSecretSignal([title, hook, draft.body].join('\\n'))",
    to: "    const signal = undefined as string | undefined",
  },
  {
    id: 'm3-secret-daily',
    claim: '去掉流水那一支的凭据黑名单（ME7 写侧另一半）',
    file: STORE,
    from: "    const signal = findSecretSignal(line)\n    if (signal !== undefined) {\n      // 拒绝留痕只写模式名，不写原文。",
    to: "    const signal = undefined as string | undefined\n    if (false && signal !== undefined) {\n      // 拒绝留痕只写模式名，不写原文。",
  },
  {
    id: 'm4-overwrite-allowed',
    claim: '把 exclusive 创建改成覆盖写 —— 拆掉「只许加法」的执行手段',
    file: STORE,
    from: "    }, body), { flag: 'wx' }).catch(error => {",
    to: "    }, body), { flag: 'w' }).catch(error => {",
  },
  {
    id: 'm5-archive-overwrites',
    claim: '去掉「归档位置已有同名文件即拒」——冻结的归档件被覆盖',
    file: STORE,
    from: "    if (await lstat(archivedAbsolute).catch(() => undefined) !== undefined) {",
    to: "    if (false && await lstat(archivedAbsolute).catch(() => undefined) !== undefined) {",
  },
  {
    id: 'm6-no-index-removal',
    claim: '归档不撤索引行 —— 注入段永久带着打不开的链接',
    file: STORE,
    from: "    const indexRemoved = await this.removeIndexLine(relativePath)",
    to: "    const indexRemoved = false",
  },
  {
    id: 'm7-poisoning-allowed',
    claim: '放开 feedback 的外部来源 —— 记忆投毒（ME6）',
    file: STORE,
    from: "    if (draft.type === 'feedback' && draft.source === 'external') {",
    to: "    if (false && draft.type === 'feedback' && draft.source === 'external') {",
  },
  {
    id: 'm8-crlf-is-hand-edit',
    claim: 'frontmatter 解析不折 CRLF —— 编辑器被当成用户（ME2 误报）',
    file: STORE,
    from: "  const text = source.replace(/\\r\\n/g, '\\n')",
    to: "  const text = source",
  },
  {
    id: 'm9-hash-not-checked',
    claim: '读条目时不比正文哈希 —— 手改检测整体失效',
    file: STORE,
    from: "      handEdited: stored === '' || stored !== digest(body),",
    to: "      handEdited: false,",
  },
  {
    id: 'm10-absolute-allowed',
    claim: '去掉绝对路径那一判（越权第一形）',
    file: STORE,
    from: "      if (/^[a-zA-Z]:[\\\\/]/.test(segment) || segment.startsWith('\\\\') || segment.startsWith('/')) {",
    to: "      if (false) {",
  },
  {
    id: 'm11-traversal-allowed',
    claim: '去掉 `..` 段那一判（越权第二形）',
    file: STORE,
    from: "      if (parts.some(part => part === '..')) {",
    to: "      if (false) {",
  },
  {
    id: 'm12-daily-pairing',
    claim: '放开 kind 配对 —— 半条流水被当成条目',
    file: TOOLS,
    from: "        if (args.type !== undefined || args.slug !== undefined || args.title !== undefined || args.hook !== undefined) {",
    to: "        if (false) {",
  },
  {
    id: 'm13-unregistered-tool',
    claim: '把两把记忆工具从产品风险字典里删掉 —— 它们会落回默认 L4，天天发卡（F-H 的那一课）',
    file: GATE,
    from: "  memory_write: { level: 'L1',",
    to: "  // memory_write: { level: 'L1',",
  },
  {
    id: 'm14-downgraded-to-l0',
    claim: '把 memory_write 悄悄降成 L0（§3.6④ 禁止的「豁免分支」的另一副面孔）',
    file: GATE,
    from: "  memory_write: { level: 'L1',",
    to: "  memory_write: { level: 'L0',",
  },
  // —— 第 3 步：常驻索引段的三条守卫 ——
  {
    id: 'm15-inject-secret-guard-off',
    claim: '注入侧不跑黑名单 —— 命中凭据的索引行进得了 system prompt（ME7 注入半）',
    file: INJECT,
    from: "    if (findSecretSignal(line) !== undefined) {",
    to: "    if (false && findSecretSignal(line) !== undefined) {",
  },
  {
    id: 'm16-inject-budget-ignored',
    claim: '超预算不裁 —— 常驻段无界膨胀（ME1）',
    file: INJECT,
    from: "  for (const victim of removalOrder(candidates)) {",
    to: "  for (const victim of [] as Candidate[]) {",
  },
  {
    id: 'm17-inject-trim-ignores-weight',
    claim: '裁剪只看位置不看类型权重 —— 老 feedback 被新鲜 reference 挤掉（ME5）',
    file: INJECT,
    from: "  return [...candidates].sort((a, b) => a.weight - b.weight || b.position - a.position)",
    to: "  return [...candidates].sort((a, b) => a.position - b.position)",
  },
  {
    id: 'm18-inject-drops-guidance',
    claim: '注入段不带读侧引导 —— 来源隔离/不虚构/单写者那几句产品承诺消失了（ME10 / ME11）',
    file: INJECT,
    from: "\\n\\n${READ_SIDE_GUIDANCE}",
    to: "\\n\\n（本段无引导）",
  },
  // —— 第 4 步：读侧打分 ——
  {
    id: 'm19-recall-no-recency',
    claim: '打分不乘时间衰减 —— τ 语义失效（DM6）',
    file: RECALL,
    from: "  const recency = Math.exp(-age / tau)",
    to: "  const recency = 1",
  },
  {
    id: 'm20-recall-empty-query-zero',
    claim: '无查询词时密度记 0 —— 常驻这一路本该恒为 1',
    file: RECALL,
    from: "  if (queryTerms.length === 0) return 1",
    to: "  if (queryTerms.length === 0) return 0",
  },
  {
    id: 'm21-recall-density-case-sensitive',
    claim: '命中密度大小写敏感 —— 换个大小写就召回不到（词法腿的脆弱处）',
    file: RECALL,
    from: "  const haystack = indexText.toLowerCase()",
    to: "  const haystack = indexText",
  },
  {
    id: 'm22-recall-type-not-validated',
    claim: '索引行类型不做名录校验 —— 未知类型被当成可打分条目',
    file: RECALL,
    from: "  return type !== undefined && (MEMORY_TYPES as readonly string[]).includes(type) ? (type as MemoryType) : undefined",
    to: "  return type as MemoryType | undefined",
  },
  // —— F-L：归档返回句里那句「别去手动补索引」的机制解释 ——
  {
    id: 'm23-fl-archive-copy-drops-mechanism',
    claim: '归档返回句去掉「索引由夜间蒸馏整段重写、缺行不是故障」—— 模型会以为索引坏了去手写 MEMORY.md，撞 ME10 单一写者',
    file: TOOLS,
    from: "；这份索引由夜间蒸馏整段重写，成员会话不写 MEMORY.md，缺行不是故障、不要手动去补",
    to: "（缺行没解释）",
  },
]

const SUITE = [
  join(ROOT, 'plugins/office-memory/store.spec.ts'),
  join(ROOT, 'plugins/office-memory/tools.spec.ts'),
  join(ROOT, 'plugins/office-memory/archive-order.spec.ts'),
  join(ROOT, 'plugins/office-memory/risk-gate.spec.ts'),
  join(ROOT, 'plugins/office-memory/inject.spec.ts'),
  join(ROOT, 'plugins/office-memory/recall.spec.ts'),
  join(ROOT, 'plugins/office-approval/risk-gate.spec.ts'),
]

function runSuite() {
  let exit = 0
  let out = ''
  try {
    out = execFileSync(process.execPath, [
      join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run', '--no-file-parallelism', ...SUITE,
    ], { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 300_000 })
  } catch (error) {
    exit = typeof error.status === 'number' ? error.status : -1
    out = `${String(error.stdout ?? '')}${String(error.stderr ?? '')}`
  }
  const plain = out.replace(/\u001B\[[0-9;]*m/g, '')
  const failed = [...new Set(
    [...plain.matchAll(/×[^\n]*/g)].map(line => line[0].replace(/^×\s*/, '').replace(/\s+\d+m?s$/, '').trim()),
  )]
  // 「跑不起来」与「没被抓住」必须分开：退出码非 0 但一条具名用例都没红，多半是语法/解析炸了。
  return { caught: exit !== 0 && failed.length > 0, failed, exit, report: plain }
}

const LOG = join(ROOT, '.spike/mutate-memory.log')
const lines = []
const flush = (line) => {
  lines.push(line)
  appendFileSync(LOG, `${line}\n`, 'utf8')
  console.log(line)
}

writeFileSync(LOG, '', 'utf8')
const baseline = runSuite()
flush(`baseline: ${baseline.caught || baseline.exit !== 0 ? `RED (${baseline.failed.join(' / ')}) —— 变异前就红，本轮结论不可信` : 'green'}`)
if (baseline.exit !== 0) {
  appendFileSync(LOG, `${baseline.report}\n`, 'utf8')
  process.exit(1)
}

for (const mutant of MUTANTS) {
  const original = await readFile(mutant.file, 'utf8')
  if (!original.includes(mutant.from)) {
    flush(`${mutant.id}: SKIPPED（锚点没找到，变异没应用）`)
    continue
  }
  await writeFile(mutant.file, original.replace(mutant.from, mutant.to), 'utf8')
  const result = runSuite()
  await writeFile(mutant.file, original, 'utf8')
  if (await readFile(mutant.file, 'utf8') !== original) throw new Error(`${mutant.id}: 还原失败`)
  flush(`${mutant.id}: ${result.caught ? '抓住' : '活下来'} —— ${String(result.failed.length)} 例红（exit=${String(result.exit)}）— ${mutant.claim}`)
  for (const name of result.failed.slice(0, 6)) appendFileSync(LOG, `    · ${name}\n`, 'utf8')
}

const survivors = lines.filter(line => line.includes('活下来') || line.includes('SKIPPED'))
flush(`结论：${String(MUTANTS.length - survivors.length)}/${String(MUTANTS.length)} 个变异被抓住`)


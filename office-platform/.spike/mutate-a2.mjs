/**
 * 记忆层第 6 步 A2 的变异检验：新守卫逐条改坏即红。
 *
 * 纪律照 `mutate-memory.mjs`：一次只跑一份 harness、日志等进程退出后再读、变异期间不起产品。
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

const ROOT = 'F:/deepseek/deepseek harness/office-platform'
const GATE = join(ROOT, 'plugins/office-approval/risk-gate.ts')
const ARM = join(ROOT, 'plugins/office-memory/arm.ts')
const INDEX = join(ROOT, 'plugins/office-memory/index.ts')
const DISTILLER = join(ROOT, 'plugins/office-memory/distiller.ts')
const APPROVAL = join(ROOT, 'plugins/office-approval/index.ts')

const MUTANTS = [
  {
    id: 'a-unregistered-distill-tool',
    claim: '把 memory_distill 从产品风险字典删掉 —— 落回默认 L4，夜里发卡、蒸馏停摆，零卡断言必须红',
    file: GATE,
    from: "  memory_distill: { level: 'L1', summarize: () => '跑一次夜间记忆蒸馏' },",
    to: "  // memory_distill 未登记（变异体 a：应落回 L4）",
  },
  {
    id: 'b-distill-downgraded-to-l0',
    claim: '把 memory_distill 悄悄降成 L0（§3.6④ 禁止的另一面：L0 连闸上留痕都没有）',
    file: GATE,
    from: "  memory_distill: { level: 'L1',",
    to: "  memory_distill: { level: 'L0',",
  },
  {
    id: 'c-distill-escalated-to-l2',
    claim: '把 memory_distill 升成 L2 —— 蒸馏进程夜里没人点卡，ME8 的零卡断言必须红',
    file: GATE,
    from: "  memory_distill: { level: 'L1',",
    to: "  memory_distill: { level: 'L2',",
  },
  {
    id: 'd-top-level-filter-off',
    claim: '中和 isTopLevelSession（恒 true）—— 子代理会话也被拿去武装，MF5 过滤断言必须红',
    file: ARM,
    from: "  return session.header?.parentSession === undefined && session.header?.origin !== 'subagent'",
    to: "  return true",
  },
  {
    id: 'e-role-gate-off',
    claim: '拆掉 index.ts 的角色门（成员也接蒸馏半边线）—— 成员注册 memory_distill / 要求蒸馏服务的断言必须红',
    file: INDEX,
    from: "  if (config.distiller) {",
    to: "  if (true) {",
  },
  {
    id: 'f-marker-write-skipped',
    claim: 'ensureDistillArmed 装成功后不写标记 —— 幂等失效、重启堆叠 recurring 任务，arm/index 的幂等断言必须红',
    file: ARM,
    from: "  await store.writeArmedJob(jobId)",
    to: "  // 变异体 f：装成功不写标记",
  },
  {
    id: 'g-empty-memory-root-accepted',
    claim: '去掉 `memoryRoot === \'\'` 的空值守卫 —— `Config` 的默认值就是空串，于是记忆目录按进程 cwd 解析成相对路径（启动器的 cwd 在内核仓库根 ⇒ 直接写进内核工作树），index.spec 的两条空值守卫断言必须红',
    file: INDEX,
    from: "  if (config.memoryRoot === '') {\n    throw new Error('office-memory: memoryRoot 是空的（必须是记忆目录的绝对路径）')\n  }",
    to: "  // 变异体 g：空 memoryRoot 不再拒绝",
  },
  {
    id: 'h-distiller-entry-member-descriptor',
    claim: '把 `distiller.ts` 的默认导出换成成员描述符 —— `--patch` 取的就是默认导出，蒸馏进程会因 `distiller:true` 配成员拓扑而压根不装，入口用例必红',
    file: DISTILLER,
    from: "import { OfficeMemoryDistiller } from './index.ts'\n\nexport default OfficeMemoryDistiller",
    to: "import { OfficeMemory } from './index.ts'\n\nexport default OfficeMemory",
  },
  {
    id: 'i-secret-guard-disabled',
    claim: '让「配了 App ID 却没 Secret」这道守卫永不触发（带空 Secret 继续装真渠道）—— 台账会看起来「卡发出去了」而没人收到过，approval/index.spec 的第一条必红',
    file: APPROVAL,
    from: "  if (appSecret === '') {\n    throw new Error(`office-approval: feishuAppId 已配置，但环境变量 ${config.feishuAppSecretEnv} 是空的`)",
    to: "  if (false) {\n    throw new Error(`office-approval: feishuAppId 已配置，但环境变量 ${config.feishuAppSecretEnv} 是空的`)",
  },
  {
    id: 'j-secret-guard-inverted',
    claim: '反转那道守卫（有 Secret 反而抛、没 Secret 放行）—— 两条用例分别拦「拦错方向」与「把装配拦死」，必红',
    file: APPROVAL,
    from: "  if (appSecret === '') {",
    to: "  if (appSecret !== '') {",
  },
  {
    id: 'k-session-query-unregistered',
    claim: '把五把 session-query 只读工具从产品风险字典删掉 —— 落回默认 L4，模型一调 session_search 就发卡、工具跑不动（F-6B 现场），L0 断言必须红',
    file: GATE,
    from: "  session_search: { level: 'L0' },\n  session_event_search: { level: 'L0' },\n  session_trace: { level: 'L0' },\n  session_event_trace: { level: 'L0' },\n  session_event_read: { level: 'L0' },",
    to: "  // 变异体 k：五把 session-query 工具未登记（应落回 L4）",
  },
  {
    id: 'l-session-search-escalated',
    claim: '把 session_search 升成 L2 —— 只读本地检索却要一张审批卡，F-6B 的 L0 断言必须红',
    file: GATE,
    from: "  session_search: { level: 'L0' },",
    to: "  session_search: { level: 'L2' },",
  },
]

const SUITE = [
  join(ROOT, 'plugins/office-memory/risk-gate.spec.ts'),
  join(ROOT, 'plugins/office-memory/arm.spec.ts'),
  join(ROOT, 'plugins/office-memory/index.spec.ts'),
  join(ROOT, 'plugins/office-memory/tools.spec.ts'),
  join(ROOT, 'plugins/office-memory/distill.spec.ts'),
  join(ROOT, 'plugins/office-approval/risk-gate.spec.ts'),
  join(ROOT, 'plugins/office-approval/index.spec.ts'),
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

const LOG = join(ROOT, '.spike/mutate-a2.log')
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

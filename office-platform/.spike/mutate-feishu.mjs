/**
 * 飞书工具层（设计小样 §5 第 1 步）的变异检验：把 `feishu_doc_read` 的每条口径挨个改坏，
 * 看 `tools.spec.ts` / `risk-gate.spec.ts` 是否变红。绿 = 那条口径没被钉住。
 *
 * 纪律同 `mutate-a2.mjs`：一次一份、逐条快照还原、判据＝有具名 `×`（退出码非 0 但零 `×` 只算「跑不起来」）。
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = 'F:/deepseek/deepseek harness/office-platform'
const TOOLS = join(ROOT, 'plugins/office-feishu/tools.ts')
const GATE = join(ROOT, 'plugins/office-approval/risk-gate.ts')

const MUTANTS = [
  {
    id: 'a-doc-read-unregistered',
    claim: '把 feishu_doc_read 从产品风险字典删掉 —— 落回默认 L4，每次读都要 owner 批卡（F-6B 同病），L0 断言必须红',
    file: GATE,
    from: "  feishu_doc_read: { level: 'L0' },",
    to: '  // 变异体 a：未登记（应落 L4）',
  },
  {
    id: 'b-parse-token-no-url',
    claim: 'parseDocToken 不再从链接里取 id（原样返回整串）⇒ 链接形态的用例必须红',
    file: TOOLS,
    from: "  const match = /feishu\\.(?:cn|com)\\/(?:docx|docs|wiki)\\/([A-Za-z0-9]+)/.exec(trimmed)\n  return match?.[1] ?? trimmed",
    to: '  return trimmed',
  },
  {
    id: 'c-method-not-get',
    claim: "读文档的 method 从 'GET' 改成 'POST' ⇒ 方法/路径断言必须红",
    file: TOOLS,
    from: "      const data = await request({ method: 'GET', path }) as { content?: unknown } | undefined",
    to: "      const data = await request({ method: 'POST', path }) as { content?: unknown } | undefined",
  },
  {
    id: 'd-no-token-retry',
    claim: '去掉 token 失效重试 ⇒ 「99991663 清缓存重试一次」的用例必须红',
    file: TOOLS,
    from: "    if (tokenInvalidCodes.has(reply.code)) {\n      tokens.invalidate()\n      reply = await call(await tokens.token())\n    }\n",
    to: '',
  },
  {
    id: 'e-doc-create-unregistered',
    claim: '把 feishu_doc_create 从产品风险字典删掉 —— 落回 L4，L2 断言必须红',
    file: GATE,
    from: "  feishu_doc_create: { level: 'L2', summarize: args => `新建飞书文档「${(args as { title?: string }).title ?? ''}」` },",
    to: '  // 变异体 e：未登记（应落 L4）',
  },
  {
    id: 'f-doc-create-downgraded',
    claim: '把 feishu_doc_create 悄悄降成 L0（对外可见的写不问人 = fail-open）⇒ L2 断言必须红',
    file: GATE,
    from: "  feishu_doc_create: { level: 'L2',",
    to: "  feishu_doc_create: { level: 'L0',",
  },
  {
    id: 'g-wrong-block-type',
    claim: '写正文的 block_type 从 2（文本）改成 1（页面块）⇒ 块形状断言必须红',
    file: TOOLS,
    from: '              block_type: 2,',
    to: '              block_type: 1,',
  },
  {
    id: 'h-content-not-split',
    claim: '正文不按换行拆段（整段塞一个块）⇒ 段落数/块形状断言必须红',
    file: TOOLS,
    from: "        ? raw.split('\\n').map(line => line.trimEnd()).filter(line => line !== '').slice(0, 50)",
    to: '        ? [raw]',
  },
  {
    id: 'i-bitable-unregistered',
    claim: '把 feishu_bitable_list_records 从产品风险字典删掉 —— 落回 L4，L0 断言必须红',
    file: GATE,
    from: "  feishu_bitable_list_records: { level: 'L0' },",
    to: '  // 变异体 i：未登记（应落 L4）',
  },
  {
    id: 'j-page-size-not-clamped',
    claim: 'page_size 不夹到 500（>500 原样传）⇒ 夹取断言必须红',
    file: TOOLS,
    from: '      const pageSize = Number.isSafeInteger(size) && size > 0 ? Math.min(size, 500) : 100',
    to: '      const pageSize = Number.isSafeInteger(size) && size > 0 ? size : 100',
  },
  {
    id: 'k-bitable-table-not-parsed',
    claim: 'parseBitableTable 不再从链接取 table_id（原样返回整串）⇒ 链接形态的用例必须红',
    file: TOOLS,
    from: "  const match = /[?&]table=([A-Za-z0-9]+)/.exec(trimmed)\n  return match?.[1] ?? trimmed",
    to: '  return trimmed',
  },
  {
    id: 'l-calendar-unregistered',
    claim: '把 feishu_calendar_list_events 从产品风险字典删掉 —— 落回 L4，L0 断言必须红',
    file: GATE,
    from: "  feishu_calendar_list_events: { level: 'L0' },",
    to: '  // 变异体 l：未登记（应落 L4）',
  },
  {
    id: 'm-calendar-method-not-get',
    claim: "列日程的 method 从 'GET' 改成 'POST' ⇒ 方法/路径断言必须红",
    file: TOOLS,
    from: "      const data = await request({\n        method: 'GET',\n        path: `/open-apis/calendar/v4/calendars/${calendarId}/events`,",
    to: "      const data = await request({\n        method: 'POST',\n        path: `/open-apis/calendar/v4/calendars/${calendarId}/events`,",
  },
  {
    id: 'n-calendar-id-not-parsed',
    claim: 'parseCalendarId 不再从链接取 calendarId（原样返回整串）⇒ 链接形态的用例必须红',
    file: TOOLS,
    from: "  const match = /[?&]calendarId=([^&\\s]+)/.exec(trimmed)\n  return match?.[1] ?? trimmed",
    to: '  return trimmed',
  },
  {
    id: 'o-bitable-create-unregistered',
    claim: '把 feishu_bitable_create_record 从字典删掉 —— 落回 L4，L2 断言必须红',
    file: GATE,
    from: "  feishu_bitable_create_record: { level: 'L2', summarize: () => '往多维表格写一条记录' },",
    to: '  // 变异体 o：未登记（应落 L4）',
  },
  {
    id: 'p-calendar-create-unregistered',
    claim: '把 feishu_calendar_create_event 从字典删掉 —— 落回 L4，L2 断言必须红',
    file: GATE,
    from: "  feishu_calendar_create_event: { level: 'L2', summarize: args => `建日历日程「${(args as { summary?: string }).summary ?? ''}」` },",
    to: '  // 变异体 p：未登记（应落 L4）',
  },
  {
    id: 'q-bitable-create-method-get',
    claim: "写多维表格记录的 method 从 'POST' 改成 'GET' ⇒ 方法断言必须红",
    file: TOOLS,
    from: "      const data = await request({\n        method: 'POST',\n        path: `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,\n        body: { fields },",
    to: "      const data = await request({\n        method: 'GET',\n        path: `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,\n        body: { fields },",
  },
  {
    id: 'r-calendar-create-weakens-summary',
    claim: '去掉「summary 不能为空」守卫 ⇒ 缺标题用例必须红',
    file: TOOLS,
    from: "      if (summary === '') throw new Error('feishu_calendar_create_event: summary 不能为空')",
    to: '      // 变异体 r：不再校验 summary',
  },
]

const SUITE = [
  join(ROOT, 'plugins/office-feishu/tools.spec.ts'),
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
  const failed = [...new Set([...plain.matchAll(/×[^\n]*/g)].map(line => line[0].replace(/^×\s*/, '').trim()))]
  return { caught: exit !== 0 && failed.length > 0, failed, exit }
}

const LOG = join(ROOT, '.spike/mutate-feishu.log')
const lines = []
const flush = (line) => { lines.push(line); appendFileSync(LOG, `${line}\n`, 'utf8'); console.log(line) }

writeFileSync(LOG, '', 'utf8')
const baseline = runSuite()
flush(`baseline: ${baseline.exit !== 0 ? `RED (${baseline.failed.join(' / ')}) —— 变异前就红，结论不可信` : 'green'}`)
if (baseline.exit !== 0) process.exit(1)

for (const mutant of MUTANTS) {
  const original = await readFile(mutant.file, 'utf8')
  if (!original.includes(mutant.from)) { flush(`${mutant.id}: SKIPPED（锚点没找到）`); continue }
  await writeFile(mutant.file, original.replace(mutant.from, mutant.to), 'utf8')
  const result = runSuite()
  await writeFile(mutant.file, original, 'utf8')
  if (await readFile(mutant.file, 'utf8') !== original) throw new Error(`${mutant.id}: 还原失败`)
  flush(`${mutant.id}: ${result.caught ? '抓住' : '活下来'} —— ${String(result.failed.length)} 例红（exit=${String(result.exit)}）— ${mutant.claim}`)
  for (const name of result.failed.slice(0, 6)) appendFileSync(LOG, `    · ${name}\n`, 'utf8')
}

const survivors = lines.filter(line => line.includes('活下来') || line.includes('SKIPPED'))
flush(`结论：${String(MUTANTS.length - survivors.length)}/${String(MUTANTS.length)} 个变异被抓住`)

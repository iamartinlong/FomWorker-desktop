/**
 * 第 6 步基线**生产者**（`.spike/step6-baseline.mjs`）的变异检验：把每条口径逐个改坏，看
 * `.spike/selftest-step6-baseline.ts` 是否出**具名红例**。
 *
 * 为什么这条契约要单独走一腿变异：`selftest-verify-step6.ts` 已经证明判定层本身有牙，但它喂进去的基线是
 * 手搓的对象 —— 也就是说「启动器真写出来的那份 JSON 能不能被判据机正确读回」从来没有断言覆盖过。
 * 第 6 步的观测分两次在场（晚上起进程 / 早上收账），这份 JSON 是中间唯一的桥；桥断了不会报错，
 * 只会让早上那张表把「还没发生」读成「被违反」（或反过来）。所以每个字段都得有变异抓得住。
 *
 * 纪律照 `mutate-u11.mjs`：一次只跑一份 harness、日志等进程退出后再读、变异期间不起产品。
 * 每个变异独立应用到原件、跑完立刻还原并按字节校验，任何一刻磁盘上只有一份变异。
 *
 * 跑法：node "F:/deepseek/deepseek harness/apps/fom-client/.spike/mutate-step6-baseline.mjs"
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const ROOT = 'F:/deepseek/deepseek harness/apps/fom-client'
const KERNEL = 'F:/deepseek/deepseek harness/deepseek-harness'
const TARGET = join(ROOT, '.spike/step6-baseline.mjs')
const SELFTEST = join(ROOT, '.spike/selftest-step6-baseline.ts')
const SEED = join(ROOT, '.spike/distill-workspace')

const MUTANTS = [
  {
    id: 'a-drop-request-file-names',
    claim: '基线不记 `requests/` 的文件名清单 —— ③ 那两枪必须红：消费端退回计数差，「别的实例删一条＋夜间多两条」会被算成只多 1 张，ME8 的归属判定（靠集合差、还要点名是哪两条）就废了',
    from: '    ledgerRequestFiles,\n',
    to: '',
  },
  {
    id: 'b-drop-run-file-names',
    claim: '基线不记 `office_memory_run` 的文件名清单 —— ④ 必须红：起手态里已有的那行对账账目会被当成夜间新增，「有对账行」变成假绿，DM8 跟着错判',
    from: '    memoryRunFiles,\n',
    to: '',
  },
  {
    id: 'c-daily-keeps-md-suffix',
    claim: '日级清单留着 `.md` 后缀 —— ① 的 DM7 那枪必须红：消费端 `listDailyDays()` 给的是 `YYYY-MM-DD`，集合差会把整份清单读成夜间新增，成员一枪还没打就已经绿',
    from: '      .map(name => name.slice(0, 10))',
    to: '      .map(name => name)',
  },
  {
    id: 'd-hash-trims-the-file',
    claim: '算 sha 前先 `trim()`（归一化口径漂移的典型形态）—— ①b 那条绝对锚必须红：`MEMORY.md` 与手改靶都以换行收尾，于是那一夜起手态就被判成「索引已整段重建」＋「手改正文被动过」，开局两个假红。⚠️ ②r 之后两端共用 `sha256File`，接缝那两条关系断言（① ②）随两端一起漂、不再报红，能抓住它的只剩「用不共用那个函数的表达式算」的锚',
    from: "    return createHash('sha256').update(fs.readFileSync(file)).digest('hex')",
    to: "    return createHash('sha256').update(fs.readFileSync(file, 'utf8').trim()).digest('hex')",
  },
  {
    id: 'e-hand-edited-path-hardcoded',
    claim: '手改靶路径写死回 `reference/hand-edited-guard.md`（＝抽出生产者之前启动器的真实形态）—— ⑤ 必须红：种子换靶后基线哈希的是另一个文件，V2 那条「手改正文一字节没动」比的根本不是同一个东西',
    from: '  const handEdited = handEditedTarget(memoryDir)',
    to: "  const handEdited = 'reference/hand-edited-guard.md'",
  },
  {
    id: 'f-watermark-shape-unvalidated',
    claim: '水位线不做形状校验、原样透出 —— ⑥ 必须红：坏形状（缺 `lastDistilledAt`）会进基线，消费端把「读不出水位线」当成「有水位线」，DM8 的倒退判定失去依据',
    from: "  const ok = typeof parsed.lastDistilledAt === 'number' && typeof parsed.lastDay === 'string'\n  return ok ? { lastDistilledAt: parsed.lastDistilledAt, lastDay: parsed.lastDay } : null",
    to: '  return parsed',
  },
  {
    id: 'g-watermark-throws-when-absent',
    claim: '水位线文件缺失时直接抛（＝抽出生产者之前 `checkSeed` 的真实形态）—— ⑥ 必须红：启动器会在两个各约 100s 的冷启动**之后**崩在 ENOENT 上，白等的正是这一夜',
    from: "  let parsed\n  try {\n    parsed = JSON.parse(fs.readFileSync(path.join(memoryDir, 'daily/.watermark'), 'utf8'))\n  } catch {\n    return null\n  }",
    to: "  const parsed = JSON.parse(fs.readFileSync(path.join(memoryDir, 'daily/.watermark'), 'utf8'))",
  },
  {
    id: 'h-armed-marker-always-true',
    claim: '`armedMarkerAtStart` 写死 true —— ① 的武装那枪必须红：判据机会把「标记还没写出来」当成「起手态就有标记、这次看不到武装事件」，第 6 步要观测的那个事件凭空消失',
    from: "    armedMarkerAtStart: fs.existsSync(path.join(memoryDir, 'daily/.distill-armed')),",
    to: '    armedMarkerAtStart: true,',
  },
  {
    id: 'i-ledger-bodies-copied-into-baseline',
    claim: '把台账正文一起抄进基线（「方便早上对账」的写法）—— ⑦ 必须红：真观测时那两个目录在 `.dsh` 下、装的是别人的 `argsSnapshot`，正文进基线就违反「只记名字与哈希」这条铁律',
    from: '    ledgerRequests: ledgerRequestFiles.length,',
    to: "    ledgerRequests: ledgerRequestFiles.length,\n    ledgerRequestBodies: ledgerRequestFiles.map(name => fs.readFileSync(path.join(requestsDir, name), 'utf8')),",
  },
  // ②s 那一组：生产端硬编码的四个文件名归 `store.ts` 所有（`.mjs` import 不到 `.ts`，所以只有 ⑨ 那条反向对账能钉住）。
  {
    id: 'j-watermark-file-renamed',
    claim: '生产端把水位线文件名改成 `daily/.distill-watermark`（＝产品 `WATERMARK_PATH` 改名的等价物）—— ⑨ 必须红：读不回 `{lastDistilledAt,lastDay}` 那一对，DM8 的倒退判定失去依据。⚠️ 这一支在 ②s 之前是**静默**的（起手态本来就 pending，缺的只是「产品写的那份生产端读不读得到」这件事没人核）',
    from: "path.join(memoryDir, 'daily/.watermark')",
    to: "path.join(memoryDir, 'daily/.distill-watermark')",
  },
  {
    id: 'k-armed-marker-file-renamed',
    claim: '生产端把武装标记文件名改成 `daily/.armed`（＝产品 `ARMED_PATH` 改名的等价物）—— ⑨ 必须红：`armedMarkerAtStart` 永远 false，于是「起手态已有标记 ⇒ 本次看不到武装事件」那一支永不触发，第 6 步要观测的武装事件会在标记其实早就在场的夜里被报成新增。⚠️ 同样在 ②s 之前是**静默**的（种子里标记本来就缺席）',
    from: "path.join(memoryDir, 'daily/.distill-armed')",
    to: "path.join(memoryDir, 'daily/.armed')",
  },
  {
    id: 'l-index-file-renamed',
    claim: '生产端把索引文件名改成 `MEMORY.markdown`（＝产品内联的 `MEMORY.md` 字面改名的等价物）—— ⑨ 必须红：哈希的根本不是 `store.writeIndex` 落的那个文件。与 j/k 不同，这一支在 ②s 之前会被 ① 那组**间接**抓住（空串 sha ⇒ `index-rebuilt` 判成「已重建」而种子那颗悬空行让 fail 现形），但红例点名的是「有一条 fail」而不是「文件名错了」，归因得靠 ⑨',
    from: "sha256File(path.join(memoryDir, 'MEMORY.md'))",
    to: "sha256File(path.join(memoryDir, 'MEMORY.markdown'))",
  },
  {
    id: 'm-daily-dir-renamed',
    claim: '生产端把日级目录名改成 `dailies` —— ① 的「member-appended-daily 停 pending」与 ⑨ 的清单对账都必须红：基线里的日级永远是空清单，DM7 那一枪在起手态就被判成「成员已追加了一整天」',
    from: "fs.readdirSync(path.join(memoryDir, 'daily'))",
    to: "fs.readdirSync(path.join(memoryDir, 'dailies'))",
  },
]

function runSelftest() {
  let exit = 0
  let out = ''
  try {
    out = execFileSync(process.execPath, ['--import', 'tsx/esm', SELFTEST, SEED], {
      cwd: KERNEL, encoding: 'utf8', stdio: 'pipe', timeout: 300_000,
    })
  } catch (error) {
    exit = typeof error.status === 'number' ? error.status : -1
    out = `${String(error.stdout ?? '')}${String(error.stderr ?? '')}`
  }
  const plain = out.replace(/\u001B\[[0-9;]*m/g, '')
  const failed = [...new Set([...plain.matchAll(/✗ (.+)/g)].map(match => match[1].trim()))]
  return { exit, failed, green: plain.includes('PASS 第 6 步基线契约') }
}

const LOG = join(ROOT, '.spike/mutate-step6-baseline.log')
const lines = []
const flush = line => {
  lines.push(line)
  appendFileSync(LOG, `${line}\n`, 'utf8')
  console.log(line)
}

writeFileSync(LOG, '', 'utf8')
const baseline = runSelftest()
flush(`baseline: ${baseline.exit === 0 && baseline.green ? 'green（0 红）' : `RED (exit=${String(baseline.exit)} failed=${String(baseline.failed.length)}) —— 变异前就红，本轮结论不可信`}`)
if (!(baseline.exit === 0 && baseline.green)) {
  appendFileSync(LOG, `${baseline.green ? '' : '（基线未绿，明细见下）'}\n`, 'utf8')
  process.exit(1)
}

for (const mutant of MUTANTS) {
  const original = await readFile(TARGET, 'utf8')
  if (!original.includes(mutant.from)) {
    flush(`${mutant.id}: SKIPPED（锚点没找到，变异没应用）`)
    continue
  }
  await writeFile(TARGET, original.replace(mutant.from, mutant.to), 'utf8')
  const result = runSelftest()
  await writeFile(TARGET, original, 'utf8')
  if (await readFile(TARGET, 'utf8') !== original) throw new Error(`${mutant.id}: 还原失败`)
  const kind = result.failed.length > 0 ? '抓住（断言式）' : result.exit === 0 ? '活下来' : '抓住（退出码非 0 但无具名红例）'
  flush(`${mutant.id}: ${kind} —— ${String(result.failed.length)} 条红 —— ${mutant.claim}`)
  // 红例全列（②s 起一份自证有 29 项，截到 6 条会让「哪几条臂抓住的」这件事只能靠推理 —— 归因就是这类 harness 的产物）。
  for (const name of result.failed.slice(0, 12)) appendFileSync(LOG, `    · ${name}\n`, 'utf8')
}

const survivors = lines.filter(line => line.includes('活下来') || line.includes('SKIPPED'))
flush(`结论：${String(MUTANTS.length - survivors.length)}/${String(MUTANTS.length)} 个变异被抓住`)

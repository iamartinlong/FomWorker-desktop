// 修复的变异检验：逐条把守卫改坏，跑 responder + recovery + feishu-channel + risk-gate 四份 spec，看有没有具名用例红。
// 用法：node .spike/fe-mutation.mjs <id...> | all
// 判定：vitest 退出码非 0 **且**能数出 `×` 行才算抓住。
// 上一版在这里翻过车：vitest 给数字与符号上了 ANSI 色，`/×\s*(.+?)\s*\d+ms$/` 这种
// 按纯文本写的正则一律失配，于是五条变异全被判成「活下来」—— 假阴性的方向比假阳性更坏，
// 因为它会把没有守卫的代码说成有守卫。所以先去色，再只按「这行有没有 ×」判。
import { readFileSync, writeFileSync, copyFileSync, appendFileSync, rmSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const RESPONDER = `${ROOT}plugins/office-approval/responder.ts`
const CHANNEL = `${ROOT}plugins/office-approval/feishu-channel.ts`
const RECOVERY = `${ROOT}plugins/office-approval/recovery.ts`
const RISK = `${ROOT}plugins/office-approval/risk-gate.ts`
const BAK = {
  [RESPONDER]: `${ROOT}.spike/fe-bak-responder.ts`,
  [CHANNEL]: `${ROOT}.spike/fe-bak-channel.ts`,
  [RECOVERY]: `${ROOT}.spike/fe-bak-recovery.ts`,
  [RISK]: `${ROOT}.spike/fe-bak-risk.ts`,
}

const COMMAND = 'node ./node_modules/vitest/vitest.mjs run plugins/office-approval/responder.spec.ts plugins/office-approval/recovery.spec.ts plugins/office-approval/feishu-channel.spec.ts plugins/office-approval/risk-gate.spec.ts > .spike/fe-mutation-run.log 2>&1'

const deferBlock = `        if (card !== undefined) {
          const current = ledger.get(record.requestId)
          if (current !== undefined && isDecidable(current, now())) {
            await channel.defer(card, expired ? '同步窗口内没人应答，已转后台等待审批' : '本次询问已作废，这条审批仍可批准')
          } else {
            await channel.recall(card, '本次询问已作废')
          }
        }`

const deferMethod = `      await patch(record, { kind: 'deferred', text }, handleOf(clicked.cardId).messageIds)`

// F-I 的短路两行（同一个 callId 的第二次询问靠它兑现已有的决定）。
const shortCircuit = `    if (record.status === 'approved' || record.status === 'consumed') return 'allowed-once'
    if (record.status === 'rejected') return 'rejected'`

// F-J 的重放正文：参数快照一字不改地交回模型。
const replayPayload = `  const payload = JSON.stringify({ name: record.toolName, arguments: record.toolArgs })`

const mutations = {
  // 改回第 8 步之前的行为：无差别撤回
  m1_recall_anything: [RESPONDER, deferBlock,
    `        if (card !== undefined) await channel.recall(card, expired ? '已转后台等待审批' : '本次询问已作废')`],
  // 丢掉「门还开不开」这个判定，永远只改文案
  m2_always_defer: [RESPONDER, deferBlock,
    `        if (card !== undefined) await channel.defer(card, expired ? '同步窗口内没人应答，已转后台等待审批' : '本次询问已作废，这条审批仍可批准')`],
  // 转后台态被当成终态：按钮置灰，口头说仍可批准、手上把入口关掉
  m3_deferred_is_settled: [CHANNEL,
    `  const settled = state.kind === 'decided' || state.kind === 'expired' || state.kind === 'superseded'`,
    `  const settled = state.kind === 'decided' || state.kind === 'expired' || state.kind === 'superseded' || state.kind === 'deferred'`],
  // defer 走 DELETE（撤回），把唯一的批准入口删掉
  m4_defer_deletes: [CHANNEL, deferMethod,
    `      for (const messageId of handleOf(clicked.cardId).messageIds) await call('DELETE', \`/open-apis/im/v1/messages/\${messageId}\`)`],
  // defer 用错卡片状态：卡被写成「已取代」，审批人以为该去点另一张
  m5_defer_wrong_state: [CHANNEL, deferMethod,
    `      await patch(record, { kind: 'superseded', text }, handleOf(clicked.cardId).messageIds)`],

  /* ---------- F-I：同一次调用的第二次询问（responder 的状态短路） ---------- */
  // 完全丢掉短路：回到第 8 步真进程实测的行为——第二次问再发一张卡，已批准的写入堵到窗口末尾
  m6_no_short_circuit: [RESPONDER, shortCircuit, ``],
  // 已批准的调用在第二次问时被改成拒绝：批准过的动作永远执行不了
  m7_decided_yes_becomes_no: [RESPONDER,
    `    if (record.status === 'approved' || record.status === 'consumed') return 'allowed-once'`,
    `    if (record.status === 'approved' || record.status === 'consumed') return 'rejected'`],
  // 已拒绝的调用在第二次问时被改成放行：把一次人的拒绝变成一次没人答的通过
  m8_rejected_becomes_yes: [RESPONDER,
    `    if (record.status === 'rejected') return 'rejected'`,
    `    if (record.status === 'rejected') return 'allowed-once'`],
  // 把 pending 也算进「已答过」：第一次还没人答，第二次问就自己兑现了
  m9_pending_counts_as_decided: [RESPONDER,
    `    if (record.status === 'approved' || record.status === 'consumed') return 'allowed-once'`,
    `    if (record.status === 'approved' || record.status === 'consumed' || record.status === 'pending') return 'allowed-once'`],

  /* ---------- F-J：重放正文必须带 justification（内核 validateEscalationArgs） ---------- */
  // 回到剔掉 justification 的旧正文：提权重放在派发前就抛 invalid escalation
  m10_strip_justification: [RECOVERY, replayPayload,
    `  const arguments_ = { ...(record.toolArgs as Record<string, unknown>) }\n  delete arguments_['justification']\n  const payload = JSON.stringify({ name: record.toolName, arguments: arguments_ })`],
  // 只给工具名、不给参数快照：模型无从「原样重放」
  m11_replay_without_args: [RECOVERY, replayPayload,
    `  const payload = JSON.stringify({ name: record.toolName, arguments: {} })`],

  /* ---------- F-H：产品字典本身（分级 + 卡片文案），第 8 步现场暴露的那一组 ---------- */
  // 未登记工具退回裸工具名：审批人只能凭名字猜，而猜错的方向是放行
  m12_summary_becomes_bare_name: [RISK,
    '  return `未识别的工具 ${toolName}（默认按最高风险处理）`',
    '  return toolName'],
  // 提问类工具漏登记 → 落回 L4：模型要先获批才能问「要不要批」（F-H 的原始症状）
  m13_ask_user_question_is_L4: [RISK,
    `  ask_user_question: { level: 'L0' },`,
    `  ask_user_question: { level: 'L4' },`],
  // 「未知按 L4」这条保守默认改成放行：MCP 动态名与一切没登记的工具都不再被问
  m14_unknown_default_fail_open: [RISK,
    `  if (rule === undefined) return 'L4'`,
    `  if (rule === undefined) return 'L0'`],
  // 出网工具悄悄写回 L0：查询词/URL 离开本机却没有任何人同意过
  m15_web_fetch_demoted: [RISK,
    `  web_fetch: { level: 'L2',`,
    `  web_fetch: { level: 'L0',`],
  // 提权参数不再升格：要求换沙箱模式的写入被当成工作区内的幂等写直接放过
  m16_escalation_not_L3: [RISK,
    `  if (permissions !== undefined) return 'L3'`,
    `  if (permissions !== undefined) return 'L1'`],
}

/** 跑一次四份 spec，返回（退出码、红掉的用例名）。用例名从落盘的日志读，避免管道截断。 */
function run() {
  let exit = 0
  try {
    execSync(COMMAND, { cwd: ROOT, encoding: 'utf8' })
  } catch (error) {
    exit = error?.status ?? -1
  }
  const log = readFileSync(`${ROOT}.spike/fe-mutation-run.log`, 'utf8')
    .replace(/\x1b\[[0-9;]*m/g, '')
  const failed = [...new Set([...log.matchAll(/×[^\n]*/g)].map(line => line[0].replace(/^×\s*/, '').replace(/\s+\d+m?s$/, '').trim()))]
  return { exit, failed }
}

const ids = process.argv.slice(2)
const targets = ids.length === 1 && ids[0] === 'all' ? Object.keys(mutations) : ids
let survived = 0

// 每次开工先按**当前**源码做快照，而不是信上一次留下的 `.bak`：
// 代码演进后旧备份会把变异跑在过期的文件上，还原时还会把新代码覆盖掉。
for (const file of [RESPONDER, CHANNEL, RECOVERY, RISK]) copyFileSync(file, BAK[file])

for (const id of targets) {
  const [file, from, to] = mutations[id]
  const source = readFileSync(file, 'utf8')
  if (!source.includes(from)) {
    console.log(`${id}: SKIPPED —— 锚点没找到，变异脚本与代码不同步`)
    survived++
    continue
  }
  writeFileSync(file, source.replace(from, to))
  const { exit, failed } = run()
  copyFileSync(BAK[file], file)
  if (exit !== 0 && failed.length > 0) {
    console.log(`${id}: 抓住 —— ${String(failed.length)} 例红`)
    for (const name of failed.slice(0, 6)) console.log(`    · ${name}`)
  } else {
    survived++
    console.log(`${id}: 活下来 —— exit=${String(exit)}，红掉的用例 ${String(failed.length)} 条`
      + (exit !== 0 ? '（跑不起来，不是通过）' : ''))
  }
}

const baseline = run()
console.log(baseline.exit === 0
  ? '还原后基线：全绿'
  : `还原后基线：红 —— ${baseline.failed.join(' / ')}`)
process.exit(survived === 0 && baseline.exit === 0 ? 0 : 1)

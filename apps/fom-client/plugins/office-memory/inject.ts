/**
 * 常驻索引段（设计 §3.3、DM4，实现顺序第 3 步）。
 *
 * 只走 `ctx.systemPrompt.section` 的 **provider 形态**，绝不用 `.context`：后者是 durable
 * user-role 快照，会把每回合都在变的索引**永久写进会话历史**（MF12 / DM4）。
 *
 * 三条守卫，都住在这个纯函数里，好在没有真模型也能被逐条断言：
 * - **预算**（ME1）：索引条目 ≤200 行且整段 ≤4 KB，超限按**类型权重**裁（不看时间 —— 见
 *   `recall.ts` 里那段关于 ME5 的说明），被裁的**原行落进 `daily`** 而不是静默丢。
 * - **secret 黑名单**（ME7）：注入侧再扫一遍，命中的条目行**不进段**，`daily` 只记计数不记内容。
 * - **来源隔离 / 不虚构**（ME6 / ME11）：这段只呈现「标题 + 钩子 + 链接」，正文永远是被引述对象；
 *   引导文案明说「没有相关条目就如实说不记得，别虚构」。
 *
 * provider 是**同步**的（内核 `text: (context) => string`），所以索引读取走 `store` 的同步入口；
 * 而 `daily` 留痕是异步副作用 —— 装配不该等落盘，`void` 掉即可，并按索引内容去重，一夜只记一次。
 */

import { createHash } from 'node:crypto'
import { findSecretSignal, type MemoryStore } from './store.ts'
import { TYPE_WEIGHTS, entryTypeFromLine } from './recall.ts'

export interface IndexBudget {
  readonly maxLines: number
  readonly maxBytes: number
}

export const DEFAULT_BUDGET: IndexBudget = { maxLines: 200, maxBytes: 4096 }

/** 段的抬头（索引非空时）。 */
const BLOCK_HEADER = '## 长期记忆索引（常驻）'

/**
 * 读侧引导 —— 这段是**产品承诺**，不是装饰，测试会逐句断言其中的关键约束（ME10 / ME11 / F-L）。
 * `interpolate` 关掉，所以下面出现的花括号、方括号都按字面呈现，不会被当成模板变量。
 */
export const READ_SIDE_GUIDANCE = [
  '怎么用这份索引：',
  '- 想看某条记忆的细节，用 `read` 打开它链接的文件（索引只放标题与一句话钩子，正文按需读）。',
  '- 想回溯历史会话原文，用 `session_search`；它按字面词匹配，且总排除你当前这个会话，所以「刚说过的那句」查不到是设计，不是坏。',
  '- 这份索引由夜间蒸馏**整段重写**。成员会话不要自己编辑或重建 `MEMORY.md`：要长期记住就走 `memory_write`（它只往 `daily` 流水留线索），索引下一夜由蒸馏补进。',
  '- 索引里缺某条**不是故障**，也不要为了「修好索引」去手写 `MEMORY.md`——那会和夜间蒸馏抢同一个文件。',
  '- 如果下面没有相关条目，就如实说「没有相关记忆」，**不要虚构记忆内容或引用**。',
].join('\n')

interface Candidate {
  readonly line: string
  readonly weight: number
  readonly position: number
}

export interface BuiltBlock {
  /** 交给 provider 的最终段文本；没有可注入条目时为空串（空段会被内核 `renderPrompt` 丢弃）。 */
  readonly block: string
  /** 超预算被裁掉的条目行（原始顺序），已交给 `daily` 留痕。 */
  readonly trimmed: readonly string[]
  /** 命中黑名单被挡在段外的条目行数（内容不外泄，只留计数）。 */
  readonly deniedCount: number
}

/** 把候选按「最该被裁」排序：权重小的先裁，权重相同则文件里靠后的先裁（保留蒸馏写在前面的）。 */
function removalOrder(candidates: readonly Candidate[]): Candidate[] {
  return [...candidates].sort((a, b) => a.weight - b.weight || b.position - a.position)
}

/** 按给定条目行装配整段（引导文案恒定附上），用于字节预算判定。 */
function assemble(entryLines: readonly string[]): string {
  if (entryLines.length === 0) return ''
  return `${BLOCK_HEADER}\n\n${entryLines.join('\n')}\n\n${READ_SIDE_GUIDANCE}`
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * 纯函数：给定 `MEMORY.md` 原文，产出注入段与被裁/被拒的信息。不碰磁盘、不落 `daily`。
 */
export function buildIndexBlock(rawIndex: string, budget: IndexBudget = DEFAULT_BUDGET): BuiltBlock {
  const lines = rawIndex.replace(/\r\n?/g, '\n').split('\n')

  const candidates: Candidate[] = []
  let deniedCount = 0
  lines.forEach((line, position) => {
    const type = entryTypeFromLine(line)
    if (type === undefined) return
    // ME7 注入侧：条目行命中黑名单就整行不进段。拒绝内容不回显（连索引行都不抄进 daily）。
    if (findSecretSignal(line) !== undefined) {
      deniedCount += 1
      return
    }
    candidates.push({ line, weight: TYPE_WEIGHTS[type], position })
  })

  // 没有可注入条目（空索引 / 全是标题 / 全被拒）→ 不注入空段（ME10「没有记忆时不注入空段」）。
  if (candidates.length === 0) {
    return { block: '', trimmed: [], deniedCount }
  }

  // 保留集用引用（Set<Candidate>）而非行文本，避免同标题行被误当作同一条裁掉。
  const kept = new Set(candidates)
  // 两条预算共用同一裁序：权重小的先裁，权重相同则文件里靠后的先裁（留住蒸馏写在前面的）。
  for (const victim of removalOrder(candidates)) {
    if (kept.size <= budget.maxLines && byteLength(assemble(sortedLines(kept))) <= budget.maxBytes) break
    kept.delete(victim)
  }

  const trimmedInOrder = candidates.filter(candidate => !kept.has(candidate)).map(candidate => candidate.line)
  return { block: assemble(sortedLines(kept)), trimmed: trimmedInOrder, deniedCount }
}

/** 保留条目按其在原文里的位置排序后取行文本（显示次序沿用蒸馏写入的顺序）。 */
function sortedLines(candidates: ReadonlySet<Candidate>): string[] {
  return [...candidates].sort((a, b) => a.position - b.position).map(candidate => candidate.line)
}

export interface IndexTextOptions {
  readonly budget?: IndexBudget
}

/**
 * 造出内核要的 `text` provider（同步返回段文本）。`store` 提供同步索引读与异步 `daily` 留痕。
 * 按索引内容去重：同一份超预算/含凭据的索引一夜只往 `daily` 记一次，不每回合刷流水。
 */
export function createIndexText(store: MemoryStore, options: IndexTextOptions = {}): () => string {
  const budget = options.budget ?? DEFAULT_BUDGET
  let lastNoticeKey = ''
  return () => {
    const raw = store.readIndexForInject()
    const { block, trimmed, deniedCount } = buildIndexBlock(raw, budget)
    if (trimmed.length > 0 || deniedCount > 0) {
      const noticeKey = createHash('sha256').update(raw, 'utf8').digest('hex')
      if (noticeKey !== lastNoticeKey) {
        lastNoticeKey = noticeKey
        if (deniedCount > 0) {
          void store.appendDaily(`常驻索引注入侧命中凭据黑名单，已拒 ${deniedCount} 行不进段（行内容未落盘）`)
        }
        if (trimmed.length > 0) {
          // 被裁的是索引行（标题+钩子，非正文），落 daily 是为了「不静默丢」，等蒸馏重整。
          void store.appendDaily(`常驻索引超预算，${trimmed.length} 条未进本回合注入段（等夜间蒸馏重整索引）：${trimmed.join(' ｜ ')}`)
        }
      }
    }
    return block
  }
}

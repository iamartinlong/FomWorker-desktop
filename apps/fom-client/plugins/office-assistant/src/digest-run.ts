/**
 * 「日终收拢」的**编排层**：取数 → 造简报 → 落盘（可注入，便于单测）。
 *
 * 与 `digest.ts` 的分工：那边是纯函数（一份输入 ⇒ 一份输出），这边只负责
 * 「从哪取」「写去哪」，因此单测里两个依赖都能换成假件。
 */
import type { AssistantDigest } from './digest.ts'
import { buildDigest, type DigestSessionTodo } from './digest.ts'
import type { AssistantItem } from './items.ts'

/** 取数 + 落盘的最小依赖（单测替换成假件）。 */
export interface DigestDeps {
  /** 域里的事项。 */
  listItems(): readonly AssistantItem[]
  /** 会话待办（读不到就是没有；不因读失败而让整份简报失败）。 */
  readTodos?(): Promise<readonly DigestSessionTodo[] | undefined>
  /** 落盘。 */
  save(digest: AssistantDigest): Promise<AssistantDigest>
  /** 时钟。 */
  now(): number
}

/**
 * 出一份「今天」的简报并落盘。
 *
 * 空集不出版：`buildDigest` 给 `undefined` 时不写、也不返回。
 * 读会话待办失败**不阻塞**简报（宁可少一行，也不要整份不出）。
 * @param deps 取数与落盘
 * @returns 写下的简报，或 `undefined`（今天没什么可收拢的）
 */
export async function runDigest(deps: DigestDeps): Promise<AssistantDigest | undefined> {
  let todos: readonly DigestSessionTodo[] | undefined
  if (deps.readTodos !== undefined) {
    try {
      todos = await deps.readTodos()
    } catch (error) {
      // 会话读失败只影响「还有几条未完成步骤」这一行，不该让整份简报失败。
      process.stderr.write(`[office-assistant] 简报读会话失败（忽略）：${String((error as Error)?.message ?? error)}\n`)
      todos = undefined
    }
  }

  const now = deps.now()
  const digest = buildDigest({
    items: deps.listItems(),
    now,
    ...(todos === undefined ? {} : { todos }),
  })
  if (digest === undefined) return undefined
  return deps.save(digest)
}

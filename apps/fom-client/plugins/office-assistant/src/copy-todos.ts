/**
 * 「从会话抄进来」的**编排**（纯逻辑 + 注入的 store），便于单测。
 *
 * 为什么要这样切：面板的 `main` 槽位拿不到 sessionId（框架只给 `{}` + `entryKey`），
 * 所以取「**最近活跃会话**」的 `todos` 投影（内核 `todo_write` 的会话级清单）；
 * 这一跳涉及会话/投影两个宿主服务 ⇒ 用**函数注入**把它们挡在测试之外。
 */
import { copyFromSessionTodos, type AssistantItem } from './items.ts'

/** 会话投影里的待办（内核 `TodoItem` 的最小面）。 */
export interface SessionTodoLike {
  readonly content: string
  readonly status: string
}

/** 把一批会话待办并入 store（按正文去重、只抄未完成）。 */
export async function copyTodosIntoStore(
  store: {
    list(): AssistantItem[]
    add(text: string, now: number, options?: { source?: 'panel' | 'tool' | 'im'; sessionId?: string }): Promise<AssistantItem>
  },
  todos: readonly SessionTodoLike[],
  now: number,
  idOf: () => string,
  sessionId?: string,
): Promise<AssistantItem[]> {
  if (todos.length === 0) return []
  const pending = copyFromSessionTodos(todos, store.list(), now, idOf)
  const created: AssistantItem[] = []
  for (const item of pending) {
    created.push(
      await store.add(item.text, now, {
        source: 'panel',
        ...(sessionId === undefined ? {} : { sessionId }),
      }),
    )
  }

  return created
}

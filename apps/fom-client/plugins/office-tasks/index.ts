/**
 * `office-tasks` —— **任务面**（D-5：task = 会话，执行端恒在 PC）。
 *
 * 上行：桌面把会话的 `turn/start` / `turn/end` 报成 `task.report`（平台登记，手机/IM 可看）。
 * 下行：收到 `task.create`（平台派活）⇒ **在 PC 建会话**并把正文投进去，用平台给的 `taskId`
 * 当会话 id 后缀（列表里只有一条，不重复）。
 *
 * 通道复用 `office-channel` 提供的 `officeImChannel`（同一条 WS，不另开连接）。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { statusOf, taskTitle, textOf } from './tasks.ts'

export * from './tasks.ts'

/** 插件的配置。 */
export const Config = z.object({
  /** 关掉 ⇒ 不上报也不接派活。 */
  enabled: z.boolean().default(true),
})

type TasksConfig = Schemastery.TypeT<typeof Config>

interface ChannelLike {
  send(frame: unknown): boolean
  onDownlink(type: string, handler: (frame: Record<string, unknown>) => void): () => void
}

interface AgentsLike {
  create(options: unknown): Promise<{ agent?: { followup(message: unknown): void } }>
}

interface AgentDefaultsLike {
  currentSelection?: () => { provider: string; model: string } | undefined
}

/** 插件名。 */
export const name = 'office-tasks'

/** 依赖通道标记 + 建会话的两面（声明式注入）。 */
export const inject = ['officeImChannel', 'agents', 'agentDefaultModel']

/**
 * 挂任务面。
 * @param ctx 插件上下文。
 * @param config 开关。
 */
export function apply(ctx: Context, config: TasksConfig): void {
  if (!config.enabled) return

  const channel = (): ChannelLike | undefined => ctx.get('officeImChannel') as ChannelLike | undefined
  /** 会话 → 标题（只认首条用户输入）。 */
  const titles = new Map<string, string>()
  /** 会话 → 平台给的 taskId（派活的会话报回同一个 id，列表里只有一条）。 */
  const taskIds = new Map<string, string>()

  const report = (taskId: string, status: 'running' | 'idle', title?: string): void => {
    const target = channel()
    if (target === undefined) return
    const frame: Record<string, unknown> = { type: 'task.report', taskId, status }
    if (title !== undefined) frame.title = title
    target.send(frame)
  }

  // 上行：内核会话事件 → 任务状态。
  ctx.effect(() => {
    const off = ctx.on('session/event', (session: unknown, event: unknown) => {
      const sessionId = String((session as { id?: unknown } | undefined)?.id ?? '')
      if (sessionId === '') return
      const type = String((event as { type?: unknown } | undefined)?.type ?? '')
      const data = (event as { data?: unknown } | undefined)?.data

      if (type === 'user/message' && !titles.has(sessionId)) {
        const title = taskTitle(textOf((data as { message?: unknown } | undefined)?.message))
        if (title !== undefined) {
          titles.set(sessionId, title)
          report(sessionId, 'running', title)
        }
        return
      }

      const status = statusOf(type)
      if (status === undefined) return
      report(taskIds.get(sessionId) ?? sessionId, status, titles.get(sessionId))
    })
    return () => {
      off()
    }
  }, 'office-tasks: 会话事件 → task.report')

  // 下行：派活（平台已定 taskId）⇒ 在 PC 建会话并投正文。
  ctx.effect(() => {
    const target = channel()
    if (target === undefined) return () => {}
    const off = target.onDownlink('task.create', (frame) => {
      void createTask(frame)
    })
    return () => {
      off()
    }

    async function createTask(frame: Record<string, unknown>): Promise<void> {
      const taskId = String(frame.taskId ?? '').trim()
      const text = String(frame.text ?? '').trim()
      if (taskId === '' || text === '') return

      const declared = ctx as unknown as { agents?: AgentsLike; agentDefaultModel?: AgentDefaultsLike }
      const agents = declared.agents ?? (ctx.get('agents') as AgentsLike | undefined)
      const defaults = declared.agentDefaultModel ?? (ctx.get('agentDefaultModel') as AgentDefaultsLike | undefined)
      const selection = defaults?.currentSelection?.()
      if (agents?.create === undefined || selection === undefined) {
        // 建不了会话就把这条标失败（别让列表里永远挂个 running）。
        report(taskId, 'idle', taskTitle(text))
        return
      }

      try {
        const sessionId = `session-${taskId}`
        const handle = await agents.create({ sessionId, agentOptions: selection, meta: { cwd: process.cwd() } })
        // ⚠️ 先登记映射再 `followup`：`followup` 会**同步**触发 `turn/start`，晚一步就会用会话 id 上报（列表出现两条）。
        taskIds.set(sessionId, taskId)
        titles.set(sessionId, taskTitle(text) ?? taskId)
        handle.agent?.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
        report(taskId, 'running', taskTitle(text))
      } catch {
        report(taskId, 'idle', taskTitle(text))
      }
    }
  }, 'office-tasks: task.create ⇒ 在 PC 建会话')
}

export default { name, inject, Config, apply }

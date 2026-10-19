/**
 * `office-assistant` 的 host 半：
 * 1. 挂 `/api/office/tasks` 代理（面板 → 平台「我的任务 / 派活」）；
 * 2. 打开「日常事项」域（`office_assistant_items`）并把 **`/api/office/items`** 暴露给面板
 *    （增 / 勾 / 改 / 删 / 从当前会话 todo 抄入）；打开时顺带跑一次 90 天清理。
 *
 * 落处是内核的 `ctx.storageDomain`（不是自建文件）：写入在 resolve 前已持久，
 * 与 `office_approval_ledger` 同一个门。
 */
import { z } from 'zod'
import { ItemStore, assistantItemsDomain, type AssistantItemsDomain } from './items-domain.ts'
import { copyTodosIntoStore, type SessionTodoLike } from './copy-todos.ts'
import { runDigest } from './digest-run.ts'
import { pushDigest, type DigestChannel } from './digest-push.ts'
import { nextDigestAt, dateKeyOf, type AssistantDigest } from './digest.ts'
import { createTasksFetch, TASKS_ROUTE, type TasksFetchDeps } from './tasks-proxy.ts'

export * from './tasks-proxy.ts'
export * from './items.ts'
export * from './items-domain.ts'

/** 「日常事项」的宿主路由。 */
export const ITEMS_ROUTE = '/api/office/items'

interface ConnectionLike {
  fetch: {
    register(route: {
      path: string
      methods: readonly string[]
      requestBody: 'buffered' | 'streaming'
      fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

interface CredentialsLike {
  resolve?(ref: string): Promise<{ value: string } | undefined> | { value: string } | undefined
}

interface DomainFacilityLike {
  open(spec: typeof assistantItemsDomain): Promise<AssistantItemsDomain>
}

interface HostContext {
  inject(names: readonly string[], callback: (child: HostContext) => void): void
  effect(callback: (() => (() => void) | void), label?: string): void
  get(name: string): unknown
  storageDomain?: DomainFacilityLike
}

/** 插件名。 */
export const name = 'office-assistant'

/** 需要凭据 + 连接（共享 `/api` 通道）+ 域设施（日常事项落盘）。 */
export const inject = ['credentials', 'connection', 'storageDomain', 'sessions', 'sessionProjections']

/** 配置：平台地址 + 日终收拢时刻。 */
export interface OfficeAssistantConfig {
  /** 平台 API 基址（默认本机 dev）。 */
  platformUrl?: string
  /**
   * 每天几点出日终简报（本地时间，0–23；缺省 18）。
   * 设成负数 ⇒ 关掉定时（仍可在面板手动出一份）。
   */
  digestHour?: number
  /**
   * 出完简报是否顺手推到该员工的 IM（缺省 true；没绑 IM / 没装通道时安静跳过）。
   * 平台只做投递、不落库（简报正文留本机）。
   */
  digestPush?: boolean
}

const DEFAULT_PLATFORM_URL = 'http://localhost:5028'

/** 日终收拢缺省时刻（本地 18:00）。 */
const DEFAULT_DIGEST_HOUR = 18

/** 定时器上限（`setTimeout` 单次不能超过 24.8 天，这里按 1 小时一轮更稳）。 */
const DIGEST_POLL_MS = 60 * 60 * 1_000

/**
 * 日终定时：等到下一个 `hour:00`（分片睡，单片不超过 1 小时）。
 *
 * 为什么用分片而不是一次长定时：机器休眠/关机后长 `setTimeout` 会漂；
 * 分片每次重新算「离下个整点还有多久」，睡醒后自然补上。
 * 同一天重复出也无害（简报按日期覆盖，幂等）。
 * @param ctx 宿主上下文（取 `effect` 以便随插件卸载）
 * @param hour 出简报的本地小时（0–23）
 * @param generate 出简报（内部已做「空集不出版」）
 * @param hasToday 今天那份是否已经出过
 */
function scheduleDailyDigest(
  ctx: HostContext,
  hour: number,
  generate: () => Promise<AssistantDigest | undefined>,
  hasToday: () => boolean,
): void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const arm = (): void => {
    if (stopped) return
    const now = Date.now()
    const target = nextDigestAt(now, hour)
    const remaining = Math.max(1_000, target - now)
    const chunk = Math.min(remaining, DIGEST_POLL_MS)
    const isFinal = chunk >= remaining

    timer = setTimeout(() => {
      if (stopped) return
      if (isFinal && !hasToday()) {
        void generate().catch((error: unknown) => {
          process.stderr.write(`[office-assistant] 日终简报失败：${String((error as Error)?.message ?? error)}\n`)
        })
      }

      arm()
    }, chunk)
    // 别拖住进程退出。
    timer.unref?.()
  }

  ctx.effect(() => {
    arm()
    return () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    }
  }, 'office-assistant: 日终收拢定时')
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const createInput = z.object({
  text: z.string(),
  dueAt: z.number().int().nonnegative().optional(),
  /** 「从会话抄进来」用。 */
  sessionId: z.string().max(100).optional(),
})

const editInput = z.object({ text: z.string() })
/**
 * 「最近活跃会话」的 todos 投影（「抄进来」的来源）。
 *
 * 面板的 `main` 槽位拿不到 sessionId（框架只给 `{}` + `entryKey`），所以取**最近活跃**的那个会话；
 * 两者都读不到（没开会话 / 该会话还没有 `todo_write`）⇒ `undefined`，由调用方回一句人话。
 * @param ctx 宿主上下文（需 `sessions` + `sessionProjections`）
 */
async function readRecentTodos(
  ctx: HostContext,
): Promise<{ sessionId: string; todos: SessionTodoLike[] } | undefined> {
  // ⚠️ 声明式注入（`inject` 里列了 `sessions`/`sessionProjections`）⇒ 必须走 `ctx.<name>`
  // 属性代理；`ctx.get(name)` 走全局表，对声明式注入**可能看不见**（内核既定坑，2026-10-17 实测）。
  const declared = ctx as unknown as {
    sessions?: { list?: () => Array<{ id?: unknown; createdAt?: unknown }>; get?: (id: unknown) => unknown }
    sessionProjections?: {
      read?: (key: string, session: unknown) => unknown
      snapshot?: (session: unknown) => { values?: Record<string, unknown> }
    }
  }
  const sessions = declared.sessions ?? (ctx.get('sessions') as typeof declared.sessions)
  if (sessions?.list === undefined) return undefined

  // `list()` 给的是「活着的会话」；按 createdAt 取最新的那个。
  const rows = sessions.list()
  const latest = [...rows]
    .filter((row) => typeof row.id === 'string')
    .sort((left, right) => Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0))[0]
  if (latest?.id === undefined) return undefined
  const sessionId = String(latest.id)

  const projections = declared.sessionProjections ?? (ctx.get('sessionProjections') as typeof declared.sessionProjections)
  if (projections === undefined) return undefined

  const session = sessions.get?.(sessionId)
  if (session === undefined) return undefined

  let todos: unknown
  if (projections.snapshot !== undefined) {
    todos = projections.snapshot(session).values?.todos
  } else if (projections.read !== undefined) {
    todos = projections.read('todos', session)
  }

  if (!Array.isArray(todos)) return undefined
  const normalized = todos
    .filter((item): item is { content: string; status: string } =>
      item !== null && typeof item === 'object'
      && typeof (item as { content?: unknown }).content === 'string'
      && typeof (item as { status?: unknown }).status === 'string')
    .map((item) => ({ content: item.content, status: item.status }))
  return normalized.length === 0 ? undefined : { sessionId, todos: normalized }
}

/**
 * 造「日常事项」路由处理器（与接线拆开，便于单测）。
 * @param store 域上的薄壳
 * @param now 时钟（UTC 毫秒，注入便于测试）
 * @param copySource 「从最近活跃会话抄进来」的来源（宿主读会话 + todos 投影；缺省不可用）
 */
export function createItemsFetch(
  store: ItemStore,
  now: () => number = Date.now,
  copySource: () => Promise<{ sessionId: string; todos: SessionTodoLike[] } | undefined> = async () => undefined,
  generateDigest: () => Promise<AssistantDigest | undefined> = async () => undefined,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const method = request.method.toUpperCase()
    const url = new URL(request.url)
    const id = url.searchParams.get('id') ?? ''
    const action = url.searchParams.get('action') ?? ''

    try {
      if (method === 'GET') {
        // 简报与事项一起返回（面板一次拉取；简报可能还没有）。
        if (action === 'digest') return json({ ok: true, digest: store.latestDigest() ?? null }, 200)
        return json({ ok: true, items: store.list(), digest: store.latestDigest() ?? null }, 200)
      }

      if (method === 'POST') {
        // 手动出一份今天的简报（面板按钮；定时器走的也是这条路）。
        if (action === 'digest') {
          const digest = await generateDigest()
          return digest === undefined
            ? json({ ok: true, digest: null, message: '今天没有可收拢的事' }, 200)
            : json({ ok: true, digest }, 200)
        }

        // 从最近活跃会话抄进来（宿主侧读会话 + todos 投影；面板拿不到 sessionId）。
        if (action === 'copy-session') {
          const source = await copySource()
          if (source === undefined) return json({ ok: false, message: '没找到可抄的会话（先开一个会话聊聊）' }, 200)
          const created = await copyTodosIntoStore(
            store,
            source.todos,
            now(),
            () => crypto.randomUUID(),
            source.sessionId,
          )
          return json({ ok: true, created: created.length, sessionId: source.sessionId }, 200)
        }

        const parsed = createInput.safeParse(await request.json().catch(() => undefined))
        if (!parsed.success) return json({ ok: false, message: '参数不对：需要 { text }' }, 400)
        const item = await store.add(parsed.data.text, now(), {
          ...(parsed.data.dueAt === undefined ? {} : { dueAt: parsed.data.dueAt }),
          ...(parsed.data.sessionId === undefined ? {} : { sessionId: parsed.data.sessionId }),
        })
        return json({ ok: true, item }, 200)
      }

      if (method === 'PATCH') {
        if (id === '') return json({ ok: false, message: '缺少 id' }, 400)
        const parsed = editInput.safeParse(await request.json().catch(() => undefined))
        if (!parsed.success) return json({ ok: false, message: '参数不对：需要 { text }' }, 400)
        const item = await store.edit(id, parsed.data.text, now())
        return item === undefined ? json({ ok: false, message: '事项不存在' }, 404) : json({ ok: true, item }, 200)
      }

      if (method === 'DELETE') {
        if (id === '') return json({ ok: false, message: '缺少 id' }, 400)
        return (await store.remove(id)) ? json({ ok: true }, 200) : json({ ok: false, message: '事项不存在' }, 404)
      }

      // 勾选走独立动作：`POST /api/office/items?action=toggle&id=…`
      if (method === 'PUT' && url.searchParams.get('action') === 'toggle') {
        if (id === '') return json({ ok: false, message: '缺少 id' }, 400)
        const item = await store.toggle(id, now())
        return item === undefined ? json({ ok: false, message: '事项不存在' }, 404) : json({ ok: true, item }, 200)
      }

      return json({ ok: false, message: `不支持的请求：${method} ${url.pathname}` }, 405)
    } catch (error) {
      // 校验类错误（空正文 / 超上限）回 400 并带上人话。
      return json({ ok: false, message: String((error as Error)?.message ?? error) }, 400)
    }
  }
}

/**
 * 挂路由 + 打开域。
 * @param ctx 宿主上下文
 * @param config 平台地址
 */
export function apply(ctx: HostContext, config: OfficeAssistantConfig = {}): void {
  const platformUrl = (config.platformUrl ?? DEFAULT_PLATFORM_URL).replace(/\/+$/u, '')
  const digestHour = config.digestHour ?? DEFAULT_DIGEST_HOUR

  // ① 日常事项域：打开 + 清理一次（D-7），再把路由挂上去。
  const facility = ctx.storageDomain ?? (ctx.get('storageDomain') as HostContext['storageDomain'] | undefined)
  if (facility !== undefined) {
    void facility
      .open(assistantItemsDomain)
      .then(async (domain) => {
        const store = new ItemStore(domain)
        const pruned = await store.prune(Date.now())
        if (pruned > 0) process.stderr.write(`[office-assistant] 已清理 ${pruned} 条超期已完成事项\n`)
        void store.pruneDigests(Date.now())

        // 取数 + 落盘（面板按钮与定时器共用这一个入口）。
        const generateDigest = async (): Promise<AssistantDigest | undefined> => {
          const digest = await runDigest({
            listItems: () => store.list(),
            readTodos: async () => (await readRecentTodos(ctx))?.todos,
            save: (saved) => store.saveDigest(saved),
            now: Date.now,
          })
          // 顺手推 IM（可选）：本机已落盘，推送成败都不影响面板可见。
          if (digest !== undefined && (config.digestPush ?? true)) {
            pushDigest(digest, {
              channel: ctx.get('officeImChannel') as DigestChannel | undefined,
              warn: (message) => process.stderr.write(`[office-assistant] ${message}\n`),
            })
          }

          return digest
        }

        // 日终定时：到点出一份；跑完就算下次。
        if (digestHour >= 0) {
          scheduleDailyDigest(
            ctx,
            digestHour,
            generateDigest,
            () => store.digestOf(dateKeyOf(Date.now())) !== undefined,
          )
        }

        ctx.inject(['connection'], (connCtx) => {
          connCtx.effect(() => {
            const conn = connCtx.get('connection') as ConnectionLike | undefined
            if (conn === undefined) return () => {}
            const dispose = conn.fetch.register({
              path: ITEMS_ROUTE,
              methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
              requestBody: 'buffered',
              // ⚠️ 用**外层 ctx**：`connCtx` 是 `inject(['connection'])` 的子上下文，不带本插件的声明式注入
              // （`sessions`/`sessionProjections` 在外层才有——同 office-channel 那次踩的坑）。
              fetch: (request) => createItemsFetch(store, Date.now, () => readRecentTodos(ctx), generateDigest)(request),
            })
            return () => {
              void dispose()
            }
          }, 'office-assistant: 日常事项（读/增/勾/改/删 + 日终简报）')
        })
      })
      .catch((error: unknown) => {
        // 域打不开不该让整个桌面起不来：只是待办块不可用，留声即可。
        process.stderr.write(`[office-assistant] 日常事项域打开失败：${String((error as Error)?.message ?? error)}\n`)
      })
  }

  // ② 任务代理（原样保留）。
  ctx.inject(['connection'], (connCtx) => {
    connCtx.effect(() => {
      const conn = connCtx.get('connection') as ConnectionLike | undefined
      if (conn === undefined) return () => {}
      const dispose = conn.fetch.register({
        path: TASKS_ROUTE,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: (request) => {
          const creds = connCtx.get('credentials') as CredentialsLike | undefined
          if (creds === undefined) return Promise.resolve(json({ ok: false, message: '凭据服务不可用（credentials）' }, 500))
          const deps: TasksFetchDeps = { platformUrl, credentials: creds }
          return createTasksFetch(deps)(request)
        },
      })
      return () => {
        void dispose()
      }
    }, 'office-assistant: 我的任务 / 派活（宿主代理平台）')
  })
}

export default { name, inject, apply }

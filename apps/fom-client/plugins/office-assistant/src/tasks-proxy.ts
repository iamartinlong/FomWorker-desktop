/**
 * `office-assistant` 的 host 半：把「我的任务 / 派活」代理到平台（**令牌不过浏览器**）。
 *
 * 为什么需要代理：浏览器不直连平台（平台不开 CORS）；宿主用凭据库里的
 * `FOM_PLATFORM_TOKEN` 去打平台 `/api/tasks`，只把结果回给面板。
 */
/** 面板用的代理路由。 */
export const TASKS_ROUTE = '/api/office/tasks'

/** 平台令牌的凭据 ref（与 office-login 一致）。 */
export const PLATFORM_TOKEN_REF = 'FOM_PLATFORM_TOKEN'

interface CredentialsLike {
  resolve?(ref: string): Promise<{ value: string } | undefined> | { value: string } | undefined
}

/** 代理依赖。 */
export interface TasksFetchDeps {
  /** 平台 API 基址（已去尾斜杠）。 */
  readonly platformUrl: string
  readonly credentials: CredentialsLike
  /** 可注入 fetch（单测）。 */
  readonly fetchImpl?: typeof fetch
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

async function token(deps: TasksFetchDeps): Promise<string> {
  const resolved = await deps.credentials.resolve?.(PLATFORM_TOKEN_REF)
  return resolved?.value ?? ''
}

/**
 * 造「我的任务」代理：
 * - `GET` ⇒ 平台 `/api/tasks` ⇒ `{ ok, tasks }`；
 * - `POST { text }` ⇒ 平台 `/api/tasks`（派活，桌面不在线回 503）⇒ `{ ok, status, taskId? }`。
 * @param deps 平台地址 / 凭据 / fetch。
 */
export function createTasksFetch(deps: TasksFetchDeps): (request: Request) => Promise<Response> {
  const doFetch = deps.fetchImpl ?? fetch
  return async (request) => {
    const accessToken = await token(deps)
    if (accessToken === '') return json({ ok: false, message: '未登录（先在账号面板登录）' }, 401)
    const auth = { authorization: `Bearer ${accessToken}` }
    const method = request.method.toUpperCase()

    if (method === 'GET') {
      let res: Response
      try {
        res = await doFetch(`${deps.platformUrl}/api/tasks`, { headers: auth })
      } catch (error) {
        return json({ ok: false, message: `连不上平台（${deps.platformUrl}）：${String((error as Error)?.message ?? error)}` }, 200)
      }
      if (!res.ok) return json({ ok: false, status: res.status, message: await res.text().catch(() => '') }, 200)
      const tasks: unknown = await res.json().catch(() => [])
      return json({ ok: true, tasks: Array.isArray(tasks) ? tasks : [] }, 200)
    }

    if (method === 'POST') {
      let body: { text?: unknown }
      try {
        body = (await request.json()) as { text?: unknown }
      } catch {
        return json({ ok: false, message: '请求体不是 JSON' }, 400)
      }

      const text = typeof body.text === 'string' ? body.text.trim() : ''
      if (text === '') return json({ ok: false, message: '说点什么再派活' }, 400)
      if (text.length > 4000) return json({ ok: false, message: '正文最长 4000 字' }, 400)

      let res: Response
      try {
        res = await doFetch(`${deps.platformUrl}/api/tasks`, {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        })
      } catch (error) {
        return json({ ok: false, message: `连不上平台（${deps.platformUrl}）：${String((error as Error)?.message ?? error)}` }, 200)
      }
      const payload = (await res.json().catch(() => ({}))) as { taskId?: unknown }
      if (!res.ok) {
        const reason = res.status === 503 ? '桌面不在线——先打开 FomWorker 再派活' : `平台回 ${res.status}`
        return json({ ok: false, status: res.status, message: reason }, 200)
      }

      return json({ ok: true, taskId: typeof payload.taskId === 'string' ? payload.taskId : '' }, 200)
    }

    return json({ ok: false, message: `不支持的请求方法 ${method}` }, 405)
  }
}

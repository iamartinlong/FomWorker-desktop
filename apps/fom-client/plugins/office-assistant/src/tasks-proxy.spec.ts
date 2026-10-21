import { describe, expect, it } from 'vitest'
import { createTasksFetch, TASKS_ROUTE } from './tasks-proxy.ts'

const TOKEN = 'platform-token-1'

const creds = (value: string | undefined) => ({
  resolve: (ref: string) => (ref === 'FOM_PLATFORM_TOKEN' && value !== undefined ? { value } : undefined),
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function request(method: string, body?: unknown): Request {
  return new Request(`http://host${TASKS_ROUTE}`, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
  })
}

describe('createTasksFetch（宿主代理「我的任务 / 派活」）', () => {
  it('未登录 ⇒ 401，不打平台', async () => {
    let called = 0
    const handler = createTasksFetch({
      platformUrl: 'http://platform',
      credentials: creds(undefined),
      fetchImpl: (async () => { called += 1; return jsonResponse([]) }) as typeof fetch,
    })
    expect((await handler(request('GET'))).status).toBe(401)
    expect(called).toBe(0)
  })

  it('GET ⇒ 带 Bearer 打 /api/tasks、回 tasks', async () => {
    let seen: { url?: string; auth?: string } = {}
    const handler = createTasksFetch({
      platformUrl: 'http://platform',
      credentials: creds(TOKEN),
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        seen = { url: String(input), auth: new Headers(init?.headers).get('authorization') ?? '' }
        return jsonResponse([{ taskId: 's1', title: '写周报', status: 'running' }])
      }) as typeof fetch,
    })
    const payload = (await (await handler(request('GET'))).json()) as { ok: boolean; tasks: Array<{ title: string }> }
    expect(seen.url).toBe('http://platform/api/tasks')
    expect(seen.auth).toBe(`Bearer ${TOKEN}`)
    expect(payload.ok).toBe(true)
    expect(payload.tasks[0]?.title).toBe('写周报')
  })

  it('POST 空正文 ⇒ 400；超长 ⇒ 400（都不打平台）', async () => {
    let called = 0
    const handler = createTasksFetch({
      platformUrl: 'http://platform',
      credentials: creds(TOKEN),
      fetchImpl: (async () => { called += 1; return jsonResponse({}) }) as typeof fetch,
    })
    expect((await handler(request('POST', { text: '   ' }))).status).toBe(400)
    expect((await handler(request('POST', { text: 'x'.repeat(4001) }))).status).toBe(400)
    expect(called).toBe(0)
  })

  it('POST ⇒ 转发正文；桌面离线（503）⇒ 给一句人话', async () => {
    const bodies: unknown[] = []
    let status = 503
    const handler = createTasksFetch({
      platformUrl: 'http://platform',
      credentials: creds(TOKEN),
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)))
        return status === 503
          ? jsonResponse({ code: 'client-offline' }, 503)
          : jsonResponse({ ok: true, taskId: 't1' }, 202)
      }) as typeof fetch,
    })

    const offline = (await (await handler(request('POST', { text: '汇总今天的邮件' }))).json()) as {
      ok: boolean
      message: string
    }
    expect(offline.ok).toBe(false)
    expect(offline.message).toContain('桌面不在线')
    expect(bodies[0]).toEqual({ text: '汇总今天的邮件' })

    status = 202
    const sent = (await (await handler(request('POST', { text: '再来一条' }))).json()) as {
      ok: boolean
      taskId: string
    }
    expect(sent.ok).toBe(true)
    expect(sent.taskId).toBe('t1')
  })
})

/**
 * `createHttpFeishuTransport` 的用例（§8 第 6 步攒下的渠道逻辑对真实网络的最后一层）。
 *
 * 这里只钉"网络形状 → `FeishuReply`"这一件事，而且刻意用**只依赖事实的断言**：
 * 每条都在抓住一类具体的改坏 —— 把非 2xx 当成功、给路径二次编码、
 * 一次调用偷偷重试、超时当成"没发出去"。
 */
import { describe, expect, it } from 'vitest'
import { FeishuTransportError, createHttpFeishuTransport } from './feishu-transport-http.ts'
import type { FeishuCall } from './feishu-channel.ts'

interface Recorded {
  readonly url: string
  readonly init: RequestInit | undefined
}

function recorder(status: number, bodyText: string, statusText = 'OK') {
  const calls: Recorded[] = []
  const transport = createHttpFeishuTransport({
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return new Response(bodyText, { status, statusText })
    },
  })
  return { calls, transport }
}

const json = (value: unknown) => JSON.stringify(value)

describe('http transport: 请求形状', () => {
  it('POST 打成一个 URL：query 编码、Bearer 头、JSON body，且只发一次请求', async () => {
    const { calls, transport } = recorder(200, json({ code: 0, msg: 'success', data: { message_id: 'om_1' } }))

    const reply = await transport({
      method: 'POST',
      path: '/open-apis/im/v1/messages',
      query: { receive_id_type: 'open_id', flag: 'a&b' },
      token: 't-abc',
      body: { receive_id: 'ou_1', msg_type: 'interactive', content: '{}' },
    })

    // 「一次调用 = 一次网络请求」是这条臂的判据：偷偷重试会在这里露出来。
    expect(calls.length).toBe(1)
    const url = new URL(calls[0]!.url)
    expect(url.origin).toBe('https://open.feishu.cn')
    expect(url.pathname).toBe('/open-apis/im/v1/messages')
    expect(url.searchParams.get('receive_id_type')).toBe('open_id')
    // query 值必须被编码，否则 `a&b` 会多出一个参数。
    expect(url.search).toContain('flag=a%26b')

    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer t-abc')
    expect(headers['Content-Type']).toContain('application/json')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      receive_id: 'ou_1',
      msg_type: 'interactive',
      content: '{}',
    })
    expect(calls[0]!.init?.method).toBe('POST')

    expect(reply).toMatchObject({ status: 200, code: 0, data: { message_id: 'om_1' } })
  })

  it('渠道给的 path 原样使用，不对已插好 message_id 的路径二次编码', async () => {
    const { calls, transport } = recorder(200, json({ code: 0, msg: 'success' }))
    await transport({ method: 'PATCH', path: '/open-apis/im/v1/messages/om_a%20b', body: { content: '{}' } })
    expect(new URL(calls[0]!.url).pathname).toBe('/open-apis/im/v1/messages/om_a%20b')
    expect(calls[0]!.url).not.toContain('%2520')
  })

  it('没有 body 的 DELETE 不写出 "null"；baseUrl 尾斜杠不产生空路径段', async () => {
    const calls: Recorded[] = []
    const transport = createHttpFeishuTransport({
      baseUrl: 'https://open.feishu.cn/',
      fetchImpl: async (url, init) => {
        calls.push({ url, init })
        return new Response('', { status: 200 })
      },
    })
    const reply = await transport({ method: 'DELETE', path: '/open-apis/im/v1/messages/om_1' })

    expect('body' in (calls[0]!.init ?? {})).toBe(false)
    expect(calls[0]!.init?.method).toBe('DELETE')
    expect(new URL(calls[0]!.url).pathname).toBe('/open-apis/im/v1/messages/om_1')
    // 空响应体仍然是成功：飞书对改卡/撤回给的是没有 data 的 code=0。
    expect(reply.code).toBe(0)
    expect('data' in reply).toBe(false)
  })

  it('获取 token 的那一次不带 Authorization', async () => {
    const { calls, transport } = recorder(
      200,
      json({ code: 0, msg: 'ok', tenant_access_token: 't-abc', expire: 7200 }),
    )
    const reply = await transport({
      method: 'POST',
      path: '/open-apis/auth/v3/tenant_access_token/internal',
      body: { app_id: 'cli_1', app_secret: 'sk_1' },
    })
    expect(calls[0]!.init?.headers).not.toHaveProperty('Authorization')
    expect(reply.tenant_access_token).toBe('t-abc')
    expect(reply.expire).toBe(7200)
  })
})

describe('http transport: 成败判据', () => {
  it('HTTP 400 配业务码 230009 不抛异常，把 code 原样交给渠道分支', async () => {
    const { transport } = recorder(
      400,
      json({ code: 230009, msg: 'out of recall time range' }),
    )
    const reply = await transport({ method: 'DELETE', path: '/open-apis/im/v1/messages/om_1' })
    // 这条是"看 code 不看 HTTP 状态"的落点：把它改成 !res.ok 就抛，用例立刻红。
    expect(reply.code).toBe(230009)
    expect(reply.status).toBe(400)
    expect(reply.msg).toContain('recall')
  })

  it('非 2xx 且响应体没给 code 时退化成 HTTP 状态，不是 0', async () => {
    const { transport } = recorder(500, json({ msg: 'internal' }), 'Internal Server Error')
    const reply = await transport({ method: 'POST', path: '/open-apis/im/v1/messages', body: {} })
    expect(reply.code).toBe(500)
    expect(reply.code).not.toBe(0)
    expect(reply.msg).toBe('internal')
  })

  it('网关返回 HTML：fail closed 成 FeishuTransportError，绝不读成发送成功', async () => {
    const { transport } = recorder(502, '<html>bad gateway</html>', 'Bad Gateway')
    await expect(transport({ method: 'POST', path: '/open-apis/im/v1/messages', body: {} })).rejects.toBeInstanceOf(
      FeishuTransportError,
    )
  })

  it('响应体是 JSON 但不是对象：同样 fail closed', async () => {
    const { transport } = recorder(200, '"queued"')
    await expect(transport({ method: 'PATCH', path: '/open-apis/im/v1/messages/om_1', body: {} })).rejects.toThrow(
      /not an object/,
    )
  })
})

describe('http transport: 超时', () => {
  it('挂死的请求在 timeoutMs 后被 abort，并说明"可能已送达"', async () => {
    const transport = createHttpFeishuTransport({
      timeoutMs: 20,
      fetchImpl: (
        _url,
        init,
      ) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted by signal')))
        }),
    })
    await expect(transport({ method: 'POST', path: '/open-apis/im/v1/messages', body: {} })).rejects.toThrow(
      /aborted after 20ms/,
    )
    await expect(transport({ method: 'POST', path: '/open-apis/im/v1/messages', body: {} })).rejects.toThrow(
      /可能已送达/,
    )
  })

  it('超时错误带着出事的 path，方便冒烟时定位是哪一步挂的', async () => {
    const transport = createHttpFeishuTransport({
      timeoutMs: 10,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    })
    const error = await transport({ method: 'DELETE', path: '/open-apis/im/v1/messages/om_zz' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(FeishuTransportError)
    expect((error as FeishuTransportError).path).toBe('/open-apis/im/v1/messages/om_zz')
  })
})

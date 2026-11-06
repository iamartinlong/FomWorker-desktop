/**
 * `office-login` —— IM 绑定（宿主代理，纯逻辑可测）。
 *
 * 浏览器**不直连平台**（平台不开 CORS）⇒ 浏览器调宿主的 `/api/office/im-bindings`，
 * 宿主带平台令牌（`ctx.credentials` 的 `FOM_PLATFORM_TOKEN`，**令牌不过浏览器**）转发到
 * 平台 `/config/im-bindings`。
 *
 * 渠道口径与平台 `Domain/Im/ImChannels`、契约 `ImBinding.channel` 同集（飞书 / 钉钉 / 企业微信）。
 */

/** 宿主的 IM 绑定路由（`GET` 列表 / `POST` 绑定 / `DELETE ?id=` 解绑）。 */
export const IM_BINDINGS_ROUTE = '/api/office/im-bindings'

/** 一个渠道的展示口径（客户端表单与列表共用）。 */
export interface ImChannelInfo {
  readonly channel: 'feishu' | 'dingtalk' | 'wecom'
  readonly label: string
  readonly idKind: string
  readonly placeholder: string
  /** 这个 id 从哪儿抄（表单旁的小字）。 */
  readonly hint: string
}

/** 三个渠道（顺序即表单里分段的顺序）。 */
export const IM_CHANNELS: readonly ImChannelInfo[] = [
  {
    channel: 'feishu',
    label: '飞书',
    idKind: 'open_id',
    placeholder: 'ou_…',
    hint: '飞书开放平台「事件订阅」或消息事件的 sender.sender_id.open_id（按应用分配）',
  },
  {
    channel: 'dingtalk',
    label: '钉钉',
    idKind: 'userid',
    placeholder: '成员 userid',
    hint: '钉钉管理后台 → 通讯录 → 成员详情里的「用户 ID」（企业内唯一）',
  },
  {
    channel: 'wecom',
    label: '企业微信',
    idKind: 'userid',
    placeholder: '成员 userid',
    hint: '企微管理后台 → 通讯录 → 成员详情里的「账号」（成员 userid）',
  },
]

/** 列表里的一行（已归一成展示用形状）。 */
export interface ImBindingView {
  readonly id: string
  readonly channel: string
  readonly channelLabel: string
  readonly idKind: string
  readonly openId: string
}

/** 按渠道查展示口径；未知渠道回退到原值。 */
export function channelInfo(channel: string): ImChannelInfo | undefined {
  return IM_CHANNELS.find((info) => info.channel === channel)
}

/** 平台返回的数组 → 展示行（缺 `channelLabel`/`idKind` 时按渠道表补齐）。 */
export function bindingViews(payload: unknown): ImBindingView[] {
  if (!Array.isArray(payload)) return []
  const rows: ImBindingView[] = []
  for (const item of payload) {
    if (item === null || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const channel = typeof row.channel === 'string' ? row.channel : ''
    const info = channelInfo(channel)
    if (typeof row.id !== 'string' || typeof row.openId !== 'string') continue
    rows.push({
      id: row.id,
      channel,
      channelLabel: typeof row.channelLabel === 'string' ? row.channelLabel : (info?.label ?? channel),
      idKind: typeof row.idKind === 'string' ? row.idKind : (info?.idKind ?? 'id'),
      openId: row.openId,
    })
  }
  return rows
}

interface CredentialsLike {
  resolve?(ref: string): Promise<{ value: string } | undefined> | { value: string } | undefined
}

/** 绑定代理的依赖。 */
export interface ImBindingsFetchDeps {
  /** 平台 API 基址（已去尾斜杠）。 */
  readonly platformUrl: string
  readonly credentials: CredentialsLike
  /** 可注入 fetch（单测）。 */
  readonly fetchImpl?: typeof fetch
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/**
 * 造 IM 绑定路由的处理函数（与接线拆开，便于单测）。
 * - `GET` ⇒ `{ ok, bindings }`（平台 `/config/im-bindings`）
 * - `POST { channel, openId }` ⇒ `{ ok, binding?/message }`（渠道/标识先本地校验）
 * - `DELETE ?id=` ⇒ `{ ok, status }`
 * @param deps - 平台地址 / 凭据 / fetch。
 * @returns Fetch 处理函数。
 */
export function createImBindingsFetch(deps: ImBindingsFetchDeps): (request: Request) => Promise<Response> {
  const doFetch = deps.fetchImpl ?? fetch

  const token = async (): Promise<string> => {
    const resolved = await deps.credentials.resolve?.('FOM_PLATFORM_TOKEN')
    return resolved?.value ?? ''
  }

  return async (request) => {
    const accessToken = await token()
    if (accessToken === '') return json({ ok: false, message: '未登录（先在账号面板登录）' }, 401)
    const auth = { authorization: `Bearer ${accessToken}` }
    const method = request.method.toUpperCase()

    if (method === 'GET') {
      let res: Response
      try {
        res = await doFetch(`${deps.platformUrl}/api/config/im-bindings`, { headers: auth })
      } catch (error) {
        return json({ ok: false, message: `连不上平台（${deps.platformUrl}）：${String((error as Error)?.message ?? error)}` }, 200)
      }
      if (!res.ok) return json({ ok: false, status: res.status, message: await res.text().catch(() => '') }, 200)
      return json({ ok: true, bindings: bindingViews(await res.json().catch(() => [])) }, 200)
    }

    if (method === 'POST') {
      let body: { channel?: unknown; openId?: unknown }
      try {
        body = (await request.json()) as { channel?: unknown; openId?: unknown }
      } catch {
        return json({ ok: false, message: '请求体不是 JSON' }, 400)
      }
      const channel = typeof body.channel === 'string' ? body.channel.trim().toLowerCase() : ''
      const openId = typeof body.openId === 'string' ? body.openId.trim() : ''
      if (channelInfo(channel) === undefined) return json({ ok: false, message: '渠道必须是飞书 / 钉钉 / 企业微信' }, 400)
      if (openId === '') return json({ ok: false, message: '请填入 IM 用户标识' }, 400)

      let res: Response
      try {
        res = await doFetch(`${deps.platformUrl}/api/config/im-bindings`, {
          method: 'POST',
          headers: { ...auth, 'content-type': 'application/json' },
          body: JSON.stringify({ channel, openId }),
        })
      } catch (error) {
        return json({ ok: false, message: `连不上平台（${deps.platformUrl}）：${String((error as Error)?.message ?? error)}` }, 200)
      }
      if (!res.ok) {
        return json({ ok: false, status: res.status, message: await res.text().catch(() => '') }, 200)
      }
      const rows = bindingViews([await res.json().catch(() => null)])
      return json({ ok: true, binding: rows[0] ?? null }, 200)
    }

    if (method === 'DELETE') {
      const id = new URL(request.url).searchParams.get('id') ?? ''
      if (id === '') return json({ ok: false, message: '缺少 id' }, 400)
      let res: Response
      try {
        res = await doFetch(`${deps.platformUrl}/api/config/im-bindings/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: auth,
        })
      } catch (error) {
        return json({ ok: false, message: `连不上平台（${deps.platformUrl}）：${String((error as Error)?.message ?? error)}` }, 200)
      }
      if (!res.ok) return json({ ok: false, status: res.status, message: await res.text().catch(() => '') }, 200)
      return json({ ok: true, status: res.status }, 200)
    }

    return json({ ok: false, message: `不支持的请求方法 ${method}` }, 405)
  }
}

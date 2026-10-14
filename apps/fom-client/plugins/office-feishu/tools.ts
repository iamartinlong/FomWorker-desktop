/**
 * 飞书工具层（设计小样 §2）：只读 `feishu_doc_read`（L0）+ 写 `feishu_doc_create`（L2）。
 *
 * 为什么是**自研定名工具**而不是 MCP：MCP 工具名是 `mcp__<server>__<rawName>`，由远端服务器在
 * **运行时**生成（`packages/mcp/mcp-client/src/tools.ts:82`），风险字典**故意不登记**这一形态 ⇒ 落
 * 「未登记 → L4」⇒ 每次读飞书文档都要 owner 批一张卡（与 F-6B 同病）。定名工具能静态登记：
 * 读 = **L0**（本地不可见、无外部副作用），写 = **L2**（对外可见），与 `read` / `web_search` 同档。
 *
 * 传输与 token 复用审批层那份（`FeishuTransport` / `createTenantTokenSource`）：一次调用一次网络
 * 请求、token 本地缓存、**成败看 `code` 不看 HTTP 状态**、命中 `tokenInvalidCodes` 清缓存重试一次。
 *
 * API 形状（按飞书官方文档，见验证记录）：
 * - 读正文：`GET /open-apis/docx/v1/documents/{id}/raw_content` → `data.content`。
 * - 建文档：`POST /open-apis/docx/v1/documents` `{title, folder_token?}` → `data.document.document_id`。
 * - 写正文：`POST /open-apis/docx/v1/documents/{id}/blocks/{id}/children?document_revision_id=-1`
 *   `{index:0, children:[{block_type:2, text:{elements:[{text_run:{content}}], style:{}}}]}`（根块 id = document_id）。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  FeishuApiError, tokenInvalidCodes,
  type FeishuReply, type FeishuTransport, type TokenSource,
} from '../office-approval/feishu-channel.ts'

export interface FeishuTools {
  readonly docRead: ToolDefinition
  readonly docCreate: ToolDefinition
  readonly bitableListRecords: ToolDefinition
  readonly bitableCreateRecord: ToolDefinition
  readonly calendarListEvents: ToolDefinition
  readonly calendarCreateEvent: ToolDefinition
}

/** 一次带鉴权的调用；token 失效码清缓存重试一次（同审批层渠道）。 */
interface RequestOptions {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  readonly path: string
  readonly body?: unknown
  readonly query?: Readonly<Record<string, string>>
}

/**
 * 从「飞书文档链接」里取 `document_id`；给了裸 id 就原样用。
 * 链接形如 `https://<tenant>.feishu.cn/docx/<id>`（也容忍 `docs` / `wiki` 段）。
 */
export function parseDocToken(input: string): string {
  const trimmed = input.trim()
  const match = /feishu\.(?:cn|com)\/(?:docx|docs|wiki)\/([A-Za-z0-9]+)/.exec(trimmed)
  return match?.[1] ?? trimmed
}

/** 从多维表格链接取 `app_token`；裸 token 原样用。链接形如 `https://<tenant>.feishu.cn/base/<app_token>`。 */
export function parseBitableApp(input: string): string {
  const trimmed = input.trim()
  const match = /feishu\.(?:cn|com)\/base\/([A-Za-z0-9]+)/.exec(trimmed)
  return match?.[1] ?? trimmed
}

/** 从多维表格链接取 `table_id`（`?table=<id>`）；裸 id 原样用。 */
export function parseBitableTable(input: string): string {
  const trimmed = input.trim()
  const match = /[?&]table=([A-Za-z0-9]+)/.exec(trimmed)
  return match?.[1] ?? trimmed
}

/** 从日程链接取 `calendarId`（app_link 里的 `?calendarId=`）；裸 id 原样用。 */
export function parseCalendarId(input: string): string {
  const trimmed = input.trim()
  const match = /[?&]calendarId=([^&\s]+)/.exec(trimmed)
  return match?.[1] ?? trimmed
}

/** 从「主日历」响应里取 `calendar_id`（官方响应形状有两种写法，都认）。 */
function firstCalendarId(data: unknown): string {
  const record = data as {
    calendar?: { calendar_id?: unknown }
    calendars?: { calendar?: { calendar_id?: unknown } }[]
  } | undefined
  const direct = record?.calendar?.calendar_id
  if (typeof direct === 'string') return direct
  const nested = record?.calendars?.[0]?.calendar?.calendar_id
  return typeof nested === 'string' ? nested : ''
}

/** Unix 秒：给数字/数字串就用，否则回落到默认。 */
function unixOr(input: unknown, fallback: number): number {
  const value = typeof input === 'number' ? input : Number(String(input ?? ''))
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/** 从 `app`（链接或裸 token）+ 可选 `table` 解析出 `{appToken, tableId}`；缺一即抛。 */
function resolveBitableTarget(appInput: string, tableArg: unknown): { appToken: string; tableId: string } {
  const appToken = parseBitableApp(appInput)
  let tableId = typeof tableArg === 'string' && tableArg !== '' ? parseBitableTable(tableArg) : ''
  if (tableId === '' && /[?&]table=/.test(appInput)) tableId = parseBitableTable(appInput)
  if (appToken === '' || tableId === '') {
    throw new Error('需要多维表格链接（含 ?table=）或 app_token + table_id')
  }
  return { appToken, tableId }
}

export function createFeishuTools(transport: FeishuTransport, tokens: TokenSource): FeishuTools {
  const request = async (options: RequestOptions): Promise<unknown> => {
    const call = (token: string): Promise<FeishuReply> => transport({
      method: options.method,
      path: options.path,
      token,
      ...(options.body === undefined ? {} : { body: options.body }),
      ...(options.query === undefined ? {} : { query: options.query }),
    })
    let reply = await call(await tokens.token())
    if (tokenInvalidCodes.has(reply.code)) {
      tokens.invalidate()
      reply = await call(await tokens.token())
    }
    if (reply.code !== 0) throw new FeishuApiError(reply.code, reply.msg ?? 'feishu request failed', options.path)
    return reply.data
  }

  /** 解析日历 id：给了就用，没给就取主日历（省略 calendar 时）。 */
  const resolveCalendar = async (calArg: unknown): Promise<string> => {
    const raw = String(calArg ?? '')
    let calendarId = raw === '' ? '' : parseCalendarId(raw)
    if (calendarId === '') {
      const primary = await request({ method: 'POST', path: '/open-apis/calendar/v4/calendars/primary' })
      calendarId = firstCalendarId(primary)
      if (calendarId === '') throw new Error('没拿到主日历 id（可显式传 calendar）')
    }
    return calendarId
  }

  const docRead = defineTool({
    name: 'feishu_doc_read',
    description: '读一篇飞书云文档（docx）的纯文本正文。参数给文档链接或 document_id。只读，不修改任何东西。',
    parameters: {
      doc: {
        type: 'string',
        required: true,
        description: '飞书文档链接（形如 https://xxx.feishu.cn/docx/<id>）或 document_id',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          documentId: { type: 'string', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      const documentId = parseDocToken(String((args as { doc?: unknown }).doc ?? ''))
      if (documentId === '') throw new Error('feishu_doc_read: 需要一个文档链接或 document_id')
      const path = `/open-apis/docx/v1/documents/${documentId}/raw_content`
      const data = await request({ method: 'GET', path }) as { content?: unknown } | undefined
      return { documentId, text: typeof data?.content === 'string' ? data.content : '' }
    },
  })

  const docCreate = defineTool({
    name: 'feishu_doc_create',
    description: '新建一篇飞书云文档（docx）。可给标题与正文；正文按换行拆成多个段落写入。**写入是对外可见动作**（会问人批准）。',
    parameters: {
      title: { type: 'string', required: true, description: '文档标题' },
      content: { type: 'string', description: '正文（可选）；按换行拆成多个段落，最多 50 段' },
      folder_token: { type: 'string', description: '目标文件夹 token（可选）；不给则建在应用默认空间' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          documentId: { type: 'string', required: true },
          title: { type: 'string', required: true },
          paragraphs: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已创建飞书文档「${value.title}」：document_id=${value.documentId}（写入 ${String(value.paragraphs)} 段）`,
      }],
    },
    async execute(args) {
      const title = String((args as { title?: unknown }).title ?? '').trim()
      if (title === '') throw new Error('feishu_doc_create: title 不能为空')
      const folder = (args as { folder_token?: unknown }).folder_token
      const created = await request({
        method: 'POST',
        path: '/open-apis/docx/v1/documents',
        body: { title, ...(typeof folder === 'string' && folder !== '' ? { folder_token: folder } : {}) },
      }) as { document?: { document_id?: unknown } } | undefined
      const documentId = typeof created?.document?.document_id === 'string' ? created.document.document_id : ''
      if (documentId === '') throw new Error('feishu_doc_create: 创建成功但没拿到 document_id')

      const raw = (args as { content?: unknown }).content
      const paragraphs = typeof raw === 'string' && raw !== ''
        ? raw.split('\n').map(line => line.trimEnd()).filter(line => line !== '').slice(0, 50)
        : []
      if (paragraphs.length > 0) {
        await request({
          method: 'POST',
          path: `/open-apis/docx/v1/documents/${documentId}/blocks/${documentId}/children`,
          query: { document_revision_id: '-1' },
          body: {
            index: 0,
            children: paragraphs.map(text => ({
              block_type: 2,
              text: { elements: [{ text_run: { content: text } }], style: {} },
            })),
          },
        })
      }
      return { documentId, title, paragraphs: paragraphs.length }
    },
  })

  const bitableListRecords = defineTool({
    name: 'feishu_bitable_list_records',
    description: '列出飞书多维表格（Base）某张数据表的记录。参数给多维表格链接（含 ?table=）或 app_token + table_id。只读。',
    parameters: {
      app: { type: 'string', required: true, description: '多维表格链接（https://xxx.feishu.cn/base/<app_token>?table=<table_id>）或 app_token' },
      table: { type: 'string', description: '数据表 table_id（链接里带 ?table= 时可省）' },
      page_size: { type: 'number', description: '每页条数，默认 100，最大 500' },
      page_token: { type: 'string', description: '翻页标记（上一次返回的 pageToken）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          appToken: { type: 'string', required: true },
          tableId: { type: 'string', required: true },
          count: { type: 'number', required: true },
          hasMore: { type: 'boolean', required: true },
          pageToken: { type: 'string', required: true },
          recordsJson: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `多维表格 ${value.tableId}：${String(value.count)} 条${value.hasMore ? '（还有更多，pageToken=' + value.pageToken + '）' : ''}\n${value.recordsJson}`,
      }],
    },
    async execute(args) {
      const { appToken, tableId } = resolveBitableTarget(
        String((args as { app?: unknown }).app ?? ''),
        (args as { table?: unknown }).table,
      )
      const size = Number((args as { page_size?: unknown }).page_size ?? 100)
      const pageSize = Number.isSafeInteger(size) && size > 0 ? Math.min(size, 500) : 100
      const token = (args as { page_token?: unknown }).page_token
      const query: Record<string, string> = { page_size: String(pageSize) }
      if (typeof token === 'string' && token !== '') query.page_token = token
      const data = await request({
        method: 'GET',
        path: `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
        query,
      }) as { items?: unknown[]; has_more?: unknown; page_token?: unknown } | undefined
      const records = Array.isArray(data?.items) ? data.items : []
      return {
        appToken,
        tableId,
        count: records.length,
        hasMore: data?.has_more === true,
        pageToken: typeof data?.page_token === 'string' ? data.page_token : '',
        recordsJson: JSON.stringify(records),
      }
    },
  })

  const calendarListEvents = defineTool({
    name: 'feishu_calendar_list_events',
    description: '列出飞书日历在给定时间范围内的日程。calendar 省略时用主日历；start_time/end_time 为 Unix 秒（省略则默认近 7 天）。只读。',
    parameters: {
      calendar: { type: 'string', description: '日历 id（省略则用主日历）' },
      start_time: { type: 'string', description: '开始时间，Unix 秒（省略则默认近 7 天）' },
      end_time: { type: 'string', description: '结束时间，Unix 秒（省略则默认现在）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          calendarId: { type: 'string', required: true },
          count: { type: 'number', required: true },
          itemsJson: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `日历 ${value.calendarId}：${String(value.count)} 个日程\n${value.itemsJson}`,
      }],
    },
    async execute(args) {
      const calendarId = await resolveCalendar((args as { calendar?: unknown }).calendar)
      const now = Math.floor(Date.now() / 1000)
      const start = unixOr((args as { start_time?: unknown }).start_time, now - 7 * 86_400)
      const end = unixOr((args as { end_time?: unknown }).end_time, now)
      const data = await request({
        method: 'GET',
        path: `/open-apis/calendar/v4/calendars/${calendarId}/events`,
        query: { start_time: String(start), end_time: String(end) },
      }) as { items?: unknown[] } | undefined
      const items = Array.isArray(data?.items) ? data.items : []
      return { calendarId, count: items.length, itemsJson: JSON.stringify(items) }
    },
  })

  const bitableCreateRecord = defineTool({
    name: 'feishu_bitable_create_record',
    description: '往飞书多维表格（Base）某张数据表**新增一条记录**。参数给多维表格链接（含 ?table=）或 app_token + table_id，fields 是「列名 → 值」的对象。**写入是对外可见动作（会问人批准）。**',
    parameters: {
      app: { type: 'string', required: true, description: '多维表格链接（含 ?table=）或 app_token' },
      table: { type: 'string', description: '数据表 table_id（链接里带 ?table= 时可省）' },
      fields: { type: 'object', additionalProperties: true, required: true, description: '要写入的字段（列名 → 值），如 {"待办事项":"写周报","状态":"进行中"}' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { recordId: { type: 'string', required: true } } },
      render: (_args, value) => [{ type: 'text', text: `已写入记录 ${value.recordId}` }],
    },
    async execute(args) {
      const { appToken, tableId } = resolveBitableTarget(
        String((args as { app?: unknown }).app ?? ''),
        (args as { table?: unknown }).table,
      )
      const fields = (args as { fields?: unknown }).fields
      if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
        throw new Error('feishu_bitable_create_record: fields 必须是「列名 → 值」的对象')
      }
      const data = await request({
        method: 'POST',
        path: `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
        body: { fields },
      }) as { record?: { record_id?: unknown } } | undefined
      const recordId = typeof data?.record?.record_id === 'string' ? data.record.record_id : ''
      if (recordId === '') throw new Error('feishu_bitable_create_record: 写入成功但没拿到 record_id')
      return { recordId }
    },
  })

  const calendarCreateEvent = defineTool({
    name: 'feishu_calendar_create_event',
    description: '在飞书日历上**新建一个日程**。start_time/end_time 为 Unix 秒；calendar 省略时用主日历。**写入是对外可见动作（会问人批准）。**',
    parameters: {
      calendar: { type: 'string', description: '日历 id（省略则用主日历）' },
      summary: { type: 'string', required: true, description: '日程标题' },
      description: { type: 'string', description: '日程描述' },
      start_time: { type: 'string', required: true, description: '开始时间，Unix 秒' },
      end_time: { type: 'string', required: true, description: '结束时间，Unix 秒' },
      timezone: { type: 'string', description: 'IANA 时区，默认 Asia/Shanghai' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { eventId: { type: 'string', required: true }, calendarId: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: `已建日程 ${value.eventId}（日历 ${value.calendarId}）` }],
    },
    async execute(args) {
      const summary = String((args as { summary?: unknown }).summary ?? '').trim()
      if (summary === '') throw new Error('feishu_calendar_create_event: summary 不能为空')
      const calendarId = await resolveCalendar((args as { calendar?: unknown }).calendar)
      const tzArg = (args as { timezone?: unknown }).timezone
      const timezone = typeof tzArg === 'string' && tzArg !== '' ? tzArg : 'Asia/Shanghai'
      const start = unixOr((args as { start_time?: unknown }).start_time, 0)
      const end = unixOr((args as { end_time?: unknown }).end_time, 0)
      if (start <= 0 || end <= 0) throw new Error('feishu_calendar_create_event: start_time / end_time 必须是非零 Unix 秒')
      const description = (args as { description?: unknown }).description
      const data = await request({
        method: 'POST',
        path: `/open-apis/calendar/v4/calendars/${calendarId}/events`,
        body: {
          summary,
          ...(typeof description === 'string' && description !== '' ? { description } : {}),
          start_time: { timestamp: String(start), timezone },
          end_time: { timestamp: String(end), timezone },
        },
      }) as { event?: { event_id?: unknown } } | undefined
      const eventId = typeof data?.event?.event_id === 'string' ? data.event.event_id : ''
      if (eventId === '') throw new Error('feishu_calendar_create_event: 创建成功但没拿到 event_id')
      return { eventId, calendarId }
    },
  })

  return { docRead, docCreate, bitableListRecords, bitableCreateRecord, calendarListEvents, calendarCreateEvent }
}

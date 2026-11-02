/**
 * 飞书工具层 `feishu_doc_read` 的验收单测（设计小样 §5 第 1 步）。
 *
 * 走 `ToolDefinition.execute` 那条真入口（参数先过内核 JSON Schema，再进我们的 execute）；
 * 传输用**假 `FeishuTransport`**（按飞书官方响应形状造），不起真网络。
 */

import { describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { FeishuApiError, type FeishuCall, type FeishuReply, type TokenSource } from '../office-approval/feishu-channel.ts'
import { createFeishuTools, parseCalendarId, parseDocToken } from './tools.ts'

function exec(): ToolRunContext {
  return {
    callId: ToolCallId('call-1'),
    rootCallId: ToolCallId('call-1'),
    name: 'feishu_doc_read',
    arguments: {},
    signal: new AbortController().signal,
    deferContext: () => {},
    concludeTurn: () => {},
  } as unknown as ToolRunContext
}

function tokens(value = 't-1'): { source: TokenSource; invalidations: number[] } {
  const invalidations: number[] = []
  return {
    invalidations,
    source: {
      token: async () => value,
      invalidate: () => { invalidations.push(1) },
    },
  }
}

describe('parseDocToken：链接与裸 id', () => {
  it('从 docx 链接里取 document_id，容忍首尾空白', () => {
    expect(parseDocToken('  https://acme.feishu.cn/docx/D0cN1abcdEFG  ')).toBe('D0cN1abcdEFG')
  })
  it('docs / wiki 段也认', () => {
    expect(parseDocToken('https://acme.feishu.cn/wiki/ABCdef123')).toBe('ABCdef123')
    expect(parseDocToken('https://acme.feishu.cn/docs/xyz789')).toBe('xyz789')
  })
  it('裸 id 原样用', () => {
    expect(parseDocToken('D0cN1abcdEFG')).toBe('D0cN1abcdEFG')
  })
})

describe('feishu_doc_read：L0 只读', () => {
  it('走 GET raw_content、带鉴权 token、返回纯文本正文', async () => {
    const calls: FeishuCall[] = []
    const transport = async (call: FeishuCall): Promise<FeishuReply> => {
      calls.push(call)
      return { status: 200, code: 0, data: { content: '会议结论：\n1. 选 A\n2. 李工出用例' } }
    }
    const { source } = tokens('t-abc')
    const tools = createFeishuTools(transport, source)

    const result = await tools.docRead.execute({ doc: 'https://acme.feishu.cn/docx/D0cN1abcdEFG' }, exec())

    expect(result).toEqual({ documentId: 'D0cN1abcdEFG', text: '会议结论：\n1. 选 A\n2. 李工出用例' })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      method: 'GET',
      path: '/open-apis/docx/v1/documents/D0cN1abcdEFG/raw_content',
      token: 't-abc',
    })
  })

  it('token 失效码（99991663）清缓存重试一次，成功返回', async () => {
    const calls: FeishuCall[] = []
    let n = 0
    const transport = async (call: FeishuCall): Promise<FeishuReply> => {
      calls.push(call)
      n += 1
      return n === 1
        ? { status: 200, code: 99991663, msg: 'tenant_access_token invalid' }
        : { status: 200, code: 0, data: { content: 'ok' } }
    }
    const { source, invalidations } = tokens('t-old')
    const tools = createFeishuTools(transport, source)

    const result = await tools.docRead.execute({ doc: 'D0cN1abcdEFG' }, exec())

    expect(result).toMatchObject({ text: 'ok' })
    expect(calls).toHaveLength(2)
    expect(invalidations).toHaveLength(1)
  })

  it('业务码非 0 抛 FeishuApiError（带 code 与 path），不是静默空串', async () => {
    const transport = async (): Promise<FeishuReply> => ({ status: 403, code: 1770001, msg: 'no permission' })
    const { source } = tokens()
    const tools = createFeishuTools(transport, source)

    const error = await tools.docRead.execute({ doc: 'D0cN1abcdEFG' }, exec())
      .then(() => undefined, (e: unknown) => e as Error)
    expect(error).toBeInstanceOf(FeishuApiError)
    expect(String(error?.message)).toContain('1770001')
    expect(String(error?.message)).toContain('/raw_content')
  })

  it('缺参数由内核 schema 拦在 execute 之前', async () => {
    const transport = async (): Promise<FeishuReply> => ({ status: 200, code: 0, data: { content: 'x' } })
    const { source } = tokens()
    const tools = createFeishuTools(transport, source)

    const error = await tools.docRead.execute({} as never, exec())
      .then(() => undefined, (e: unknown) => e as Error)
    expect(String(error?.message)).toContain('doc')
  })

  it('render 把正文交给模型（不是把 JSON 塞回去）', () => {
    const tools = createFeishuTools(async () => ({ status: 200, code: 0 }), tokens().source)
    const rendered = tools.docRead.output.render({ doc: 'x' }, { documentId: 'x', text: '正文' })
    expect(rendered).toEqual([{ type: 'text', text: '正文' }])
  })
})

describe('feishu_doc_create：L2 写', () => {
  it('先建文档（title）再写正文块（block_type 2），正文按换行拆段', async () => {
    const calls: FeishuCall[] = []
    const transport = async (call: FeishuCall): Promise<FeishuReply> => {
      calls.push(call)
      if (call.path === '/open-apis/docx/v1/documents') return { status: 200, code: 0, data: { document: { document_id: 'DOC-1' } } }
      return { status: 200, code: 0, data: {} }
    }
    const { source } = tokens('t-abc')
    const tools = createFeishuTools(transport, source)

    const result = await tools.docCreate.execute(
      { title: '周报', content: '本周进展\n\n下周计划' },
      exec(),
    )

    expect(result).toMatchObject({ documentId: 'DOC-1', title: '周报', paragraphs: 2 })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/open-apis/docx/v1/documents', body: { title: '周报' }, token: 't-abc' })
    expect(calls[1]).toMatchObject({
      method: 'POST',
      path: '/open-apis/docx/v1/documents/DOC-1/blocks/DOC-1/children',
      query: { document_revision_id: '-1' },
    })
    expect(calls[1]?.body).toMatchObject({
      index: 0,
      children: [
        { block_type: 2, text: { elements: [{ text_run: { content: '本周进展' } }] } },
        { block_type: 2, text: { elements: [{ text_run: { content: '下周计划' } }] } },
      ],
    })
  })

  it('不带正文时只建文档、不发第二次调用', async () => {
    const calls: FeishuCall[] = []
    const transport = async (call: FeishuCall): Promise<FeishuReply> => {
      calls.push(call)
      return { status: 200, code: 0, data: { document: { document_id: 'DOC-2' } } }
    }
    const { source } = tokens()
    const tools = createFeishuTools(transport, source)

    const result = await tools.docCreate.execute({ title: '空文档' }, exec())

    expect(result).toMatchObject({ documentId: 'DOC-2', paragraphs: 0 })
    expect(calls).toHaveLength(1)
  })

  it('给了 folder_token 就带上', async () => {
    const calls: FeishuCall[] = []
    const transport = async (call: FeishuCall): Promise<FeishuReply> => {
      calls.push(call)
      return { status: 200, code: 0, data: { document: { document_id: 'DOC-3' } } }
    }
    const { source } = tokens()
    const tools = createFeishuTools(transport, source)
    await tools.docCreate.execute({ title: 'x', folder_token: 'fld-1' }, exec())
    expect(calls[0]?.body).toMatchObject({ title: 'x', folder_token: 'fld-1' })
  })

  it('建了却没拿到 document_id ⇒ 报错（不当成功）', async () => {
    const transport = async (): Promise<FeishuReply> => ({ status: 200, code: 0, data: {} })
    const { source } = tokens()
    const tools = createFeishuTools(transport, source)
    const error = await tools.docCreate.execute({ title: 'x' }, exec()).then(() => undefined, (e: unknown) => e as Error)
    expect(String(error?.message)).toContain('document_id')
  })

  it('业务码非 0 抛 FeishuApiError', async () => {
    const transport = async (): Promise<FeishuReply> => ({ status: 403, code: 1770040, msg: 'no folder permission' })
    const { source } = tokens()
    const tools = createFeishuTools(transport, source)
    const error = await tools.docCreate.execute({ title: 'x' }, exec()).then(() => undefined, (e: unknown) => e as Error)
    expect(error).toBeInstanceOf(FeishuApiError)
    expect(String(error?.message)).toContain('1770040')
  })
})

describe('feishu_bitable_list_records：L0 只读', () => {
  it('从链接取 app_token 与 table_id，走 GET records 带 page_size，返回记录/hasMore/pageToken', async () => {
    const calls: FeishuCall[] = []
    const transport = async (call: FeishuCall): Promise<FeishuReply> => {
      calls.push(call)
      return { status: 200, code: 0, data: { items: [{ record_id: 'rec1', fields: { 名称: '甲' } }], has_more: true, page_token: 'p2' } }
    }
    const { source } = tokens('t-abc')
    const tools = createFeishuTools(transport, source)

    const result = await tools.bitableListRecords.execute(
      { app: 'https://acme.feishu.cn/base/appXYZ?table=tbl123&view=vew1' },
      exec(),
    )

    expect(result).toMatchObject({
      appToken: 'appXYZ', tableId: 'tbl123', hasMore: true, pageToken: 'p2', count: 1,
      recordsJson: expect.stringContaining('甲'),
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      method: 'GET',
      path: '/open-apis/bitable/v1/apps/appXYZ/tables/tbl123/records',
      query: { page_size: '100' },
      token: 't-abc',
    })
  })

  it('显式传 table 与 page_token / page_size（>500 夹到 500）', async () => {
    const calls: FeishuCall[] = []
    const transport = async (call: FeishuCall): Promise<FeishuReply> => {
      calls.push(call)
      return { status: 200, code: 0, data: { items: [], has_more: false } }
    }
    const { source } = tokens()
    const tools = createFeishuTools(transport, source)
    await tools.bitableListRecords.execute({ app: 'appXYZ', table: 'tbl123', page_size: 600, page_token: 'p9' }, exec())
    expect(calls[0]?.query).toEqual({ page_size: '500', page_token: 'p9' })
  })

  it('链接里没 ?table= 又没显式传 ⇒ 报错（不猜）', async () => {
    const transport = async (): Promise<FeishuReply> => ({ status: 200, code: 0, data: {} })
    const { source } = tokens()
    const tools = createFeishuTools(transport, source)
    const error = await tools.bitableListRecords.execute({ app: 'https://acme.feishu.cn/base/appXYZ' }, exec())
      .then(() => undefined, (e: unknown) => e as Error)
    expect(String(error?.message)).toContain('table_id')
  })
})

describe('feishu_calendar_list_events：L0 只读', () => {
  it('显式 calendar id：GET events 带 start/end，返回 count/itemsJson', async () => {
    const calls: FeishuCall[] = []
    const transport = async (call: FeishuCall): Promise<FeishuReply> => {
      calls.push(call)
      return { status: 200, code: 0, data: { items: [{ event_id: 'e1', summary: '周会' }] } }
    }
    const { source } = tokens('t-abc')
    const tools = createFeishuTools(transport, source)
    const result = await tools.calendarListEvents.execute(
      { calendar: 'cal_1', start_time: '1700000000', end_time: '1700086400' },
      exec(),
    )
    expect(result).toMatchObject({ calendarId: 'cal_1', count: 1, itemsJson: expect.stringContaining('周会') })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      method: 'GET',
      path: '/open-apis/calendar/v4/calendars/cal_1/events',
      query: { start_time: '1700000000', end_time: '1700086400' },
    })
  })

  it('省略 calendar 时先 POST primary 再列日程', async () => {
    const calls: FeishuCall[] = []
    const transport = async (call: FeishuCall): Promise<FeishuReply> => {
      calls.push(call)
      if (call.path === '/open-apis/calendar/v4/calendars/primary') {
        return { status: 200, code: 0, data: { calendars: [{ calendar: { calendar_id: 'cal_primary' } }] } }
      }
      return { status: 200, code: 0, data: { items: [] } }
    }
    const { source } = tokens()
    const tools = createFeishuTools(transport, source)
    const result = await tools.calendarListEvents.execute({}, exec())
    expect(result).toMatchObject({ calendarId: 'cal_primary', count: 0 })
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/open-apis/calendar/v4/calendars/primary' })
    expect(calls[1]).toMatchObject({ method: 'GET', path: '/open-apis/calendar/v4/calendars/cal_primary/events' })
  })

  it('从 app_link 里取 calendarId', () => {
    expect(parseCalendarId('https://applink.feishu.cn/client/calendar/event/detail?calendarId=feishu.cn_abc@group.calendar.feishu.cn&key=x'))
      .toBe('feishu.cn_abc@group.calendar.feishu.cn')
  })
})

describe('feishu_bitable_create_record：L2 写', () => {
  it('POST records 带 {fields}，返回 recordId', async () => {
    const calls: FeishuCall[] = []
    const transport = async (call: FeishuCall): Promise<FeishuReply> => {
      calls.push(call)
      return { status: 200, code: 0, data: { record: { record_id: 'rec-new' } } }
    }
    const { source } = tokens('t-abc')
    const tools = createFeishuTools(transport, source)
    const result = await tools.bitableCreateRecord.execute(
      { app: 'https://acme.feishu.cn/base/appX?table=tblY', fields: { 待办: '写周报', 状态: '进行中' } },
      exec(),
    )
    expect(result).toMatchObject({ recordId: 'rec-new' })
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/open-apis/bitable/v1/apps/appX/tables/tblY/records',
      body: { fields: { 待办: '写周报', 状态: '进行中' } },
    })
  })

  it('fields 不是对象 ⇒ 报错（不把数组/空当字段）', async () => {
    const transport = async (): Promise<FeishuReply> => ({ status: 200, code: 0, data: { record: { record_id: 'x' } } })
    const { source } = tokens()
    const tools = createFeishuTools(transport, source)
    const error = await tools.bitableCreateRecord.execute({ app: 'appX', table: 'tblY', fields: [] }, exec())
      .then(() => undefined, (e: unknown) => e as Error)
    expect(String(error?.message)).toContain('fields')
  })
})

describe('feishu_calendar_create_event：L2 写', () => {
  it('POST events 带 summary/start/end/timezone，返回 eventId', async () => {
    const calls: FeishuCall[] = []
    const transport = async (call: FeishuCall): Promise<FeishuReply> => {
      calls.push(call)
      return { status: 200, code: 0, data: { event: { event_id: 'evt-1' } } }
    }
    const { source } = tokens()
    const tools = createFeishuTools(transport, source)
    const result = await tools.calendarCreateEvent.execute(
      { calendar: 'cal_1', summary: '周会', start_time: '1700000000', end_time: '1700003600' },
      exec(),
    )
    expect(result).toMatchObject({ eventId: 'evt-1', calendarId: 'cal_1' })
    expect(calls[0]).toMatchObject({
      method: 'POST',
      path: '/open-apis/calendar/v4/calendars/cal_1/events',
      body: {
        summary: '周会',
        start_time: { timestamp: '1700000000', timezone: 'Asia/Shanghai' },
        end_time: { timestamp: '1700003600', timezone: 'Asia/Shanghai' },
      },
    })
  })

  it('缺 summary 或 start/end ⇒ 报错（不建一个没标题/没时间的日程）', async () => {
    const transport = async (): Promise<FeishuReply> => ({ status: 200, code: 0, data: { event: { event_id: 'x' } } })
    const { source } = tokens()
    const tools = createFeishuTools(transport, source)
    const noSummary = await tools.calendarCreateEvent.execute({ calendar: 'c', start_time: '1', end_time: '2' }, exec())
      .then(() => undefined, (e: unknown) => e as Error)
    expect(String(noSummary?.message)).toContain('summary')
    const blankSummary = await tools.calendarCreateEvent.execute({ calendar: 'c', summary: '   ', start_time: '1', end_time: '2' }, exec())
      .then(() => undefined, (e: unknown) => e as Error)
    expect(String(blankSummary?.message)).toContain('summary')
    const noTimes = await tools.calendarCreateEvent.execute({ calendar: 'c', summary: 'x', start_time: '0', end_time: '0' }, exec())
      .then(() => undefined, (e: unknown) => e as Error)
    expect(String(noTimes?.message)).toContain('Unix 秒')
  })
})

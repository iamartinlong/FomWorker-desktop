/**
 * `memory_write` / `memory_archive` / `memory_distill`（设计 DM9、§3.2 写入协议、§3.6③④、§3.5）。
 *
 * 前两把是记忆目录唯一的模型可见**条目**写入口，第三把是**索引**唯一的模型可见触发口。
 * DM9 的动机不是好看：裸 `write` 写工作区外的记忆目录必然撞 `FS_SANDBOX_DENIED` ⇒ 提权 ⇒
 * 一次调用被问两遍（F-I 那一类现场），夜里没人点卡，蒸馏就永远跑不完。受控工具写在自家目录**内**，
 * 沙箱闸根本不参与，参与的是我们自己的收敛与黑名单（`store.ts`）。
 *
 * `memory_distill` 只在**蒸馏角色**（给了 `ledger`）时装出来：成员进程连这把工具的名字都不该看见，
 * 否则成员会话能把「按分值整段重写索引」触发进来 = ME10 双写者的第二个入口。
 *
 * §3.6④ 的那条纪律在这里落地为「没有豁免分支」：三个工具名照常登记进产品风险字典
 * （`office-approval/risk-gate.ts`），走的是同一条 `tools/pre-execute` waterfall。
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { distillOnce } from './distill.ts'
import type { MemoryRunLedger } from './run-ledger.ts'
import {
  MEMORY_SOURCES, MEMORY_TYPES, MemoryRefusalError,
  type MemorySource, type MemoryStore, type MemoryType,
} from './store.ts'

/** `kind` 决定哪些字段必填，而 JSON Schema 表达不了条件必填 —— 所以配对在 execute 里判，报错给模型看。 */
const PAIRING = 'kind=entry 需要 type/slug/title/hook/body；kind=daily 只需要 body（要追加的那一行流水正文）'

function need(value: string | undefined, field: string): string {
  const text = value?.trim() ?? ''
  if (text === '') throw new MemoryRefusalError(`${PAIRING}。当前缺少 ${field}`)
  return text
}

export interface MemoryTools {
  readonly write: ToolDefinition
  readonly archive: ToolDefinition
  /** 只有蒸馏角色（给了 `ledger`）的构建里存在；成员进程没有这第三把。 */
  readonly distill?: ToolDefinition
}

/** `createMemoryTools(store, ledger)` 的产物：`distill` 必然在场，装配侧不必再判空。 */
export interface DistillerMemoryTools extends MemoryTools {
  readonly distill: ToolDefinition
}

/** 蒸馏角色：带台账装出三把工具（`memory_distill` 的对账行要落 `office_memory_run`）。 */
export function createMemoryTools(store: MemoryStore, ledger: MemoryRunLedger): DistillerMemoryTools
/** 成员角色：只有两把写工具。不装 `memory_distill`，也不要求台账/调度任何服务。 */
export function createMemoryTools(store: MemoryStore): MemoryTools
export function createMemoryTools(store: MemoryStore, ledger?: MemoryRunLedger): MemoryTools {
  const write = defineTool({
    name: 'memory_write',
    description:
      '把值得长期记住的事实写进记忆目录：kind=entry 新增一条带类型与 slug 的条目，kind=daily 往当天流水追加一行。'
      + '只许新增与追加 —— 改一条老记忆的正确做法是「写一条新的 + 归档旧的」，就地重写会被拒。'
      + '正文不许含任何明文凭据（命中黑名单直接拒），需要密钥时只写它所在的环境变量名或位置指针。',
    parameters: {
      kind: {
        type: 'string',
        required: true,
        enum: ['entry', 'daily'],
        description: 'entry = 新增长期条目并留下索引线索；daily = 只往当天流水追加一行。',
      },
      type: {
        type: 'string',
        enum: [...MEMORY_TYPES],
        description: '条目类型（kind=entry 必填）：user 用户画像 / feedback 做法纠正 / project 进行中的工作 / reference 外部系统位置。',
      },
      slug: {
        type: 'string',
        description: '条目文件名（小写字母、数字、连字符，2–80 字符）。同名已存在即拒 —— 这一句就是「不许覆盖老条目」的落点。',
      },
      title: { type: 'string', description: '条目标题，进索引那一行的方括号里。' },
      hook: { type: 'string', description: '一句话钩子：未来的会话只看得到这一句，所以要能据此判断值不值得点开正文。' },
      body: { type: 'string', required: true, description: '条目正文（Markdown）或要追加到当天流水的那一行。' },
      source: {
        type: 'string',
        enum: [...MEMORY_SOURCES],
        description: '内容来源：session 本次会话里得到 / user 用户明说 / external 从网页或文档抓取。feedback 类不接受 external。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true },
          path: { type: 'string', required: true },
          indexLine: { type: 'string', required: true },
          recordedIn: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `已写入 ${value.path}（当天流水：${value.recordedIn}）` }],
    },
    async execute(args, exec) {
      const body = need(args.body, 'body')
      const sourceSession = exec.agent?.session.id

      if (args.kind === 'daily') {
        if (args.type !== undefined || args.slug !== undefined || args.title !== undefined || args.hook !== undefined) {
          throw new MemoryRefusalError(`kind=daily 不许带 type/slug/title/hook：${PAIRING}`)
        }
        const recordedIn = await store.appendDaily(body)
        return { kind: 'daily', path: recordedIn, indexLine: '', recordedIn }
      }

      const entry = await store.writeEntry({
        type: need(args.type, 'type') as MemoryType,
        slug: need(args.slug, 'slug'),
        title: need(args.title, 'title'),
        hook: need(args.hook, 'hook'),
        body,
        source: (args.source ?? 'session') as MemorySource,
        ...(sourceSession === undefined ? {} : { sourceSession }),
      })
      return { kind: 'entry', path: entry.relativePath, indexLine: entry.indexLine, recordedIn: entry.recordedIn }
    },
  })

  const archive = defineTool({
    name: 'memory_archive',
    description:
      '把一条记忆条目移出活跃集（进 archived/<年份>/）并撤掉索引里指向它的那一行。理由必填 —— 归档是要能被回看的，'
      + '"忘了为什么撤"就等于没归档。它只移动文件，不改写正文，也不能用来删内容。',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: '条目的相对路径，如 `project/report-revision.md`。绝对路径、`..` 穿越、符号链接都会被拒。',
      },
      reason: { type: 'string', required: true, description: '为什么不再活跃：被取代（注明新条目路径）/ 已结项 / 已失效。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          archivedTo: { type: 'string', required: true },
          indexRemoved: { type: 'boolean', required: true },
          recordedIn: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        // F-L：成员进程根本不写 `MEMORY.md`（索引由夜间蒸馏整段重写），所以「索引里没有它的行」是常态、
        // 不是故障。这句若不解释机制，真模型会读成「索引坏了」并主动去补 = ME10 的双写。
        text: `已归档到 ${value.archivedTo}${value.indexRemoved
          ? '，索引里指向它的行已撤'
          : '；这份索引由夜间蒸馏整段重写，成员会话不写 MEMORY.md，缺行不是故障、不要手动去补'}`,
      }],
    },
    async execute(args) {
      return await store.archiveEntry(need(args.path, 'path'), need(args.reason, 'reason'))
    },
  })

  const tools: MemoryTools = { write, archive }
  if (ledger === undefined) return tools
  // 收窄后的局部量：`execute` 闭包捕获它而不是可再赋值的参数，类型上台账必然在场。
  const runLedger = ledger

  const distill = defineTool({
    name: 'memory_distill',
    description:
      '触发一次夜间蒸馏的确定性机制半边：按水位线检查新的日级流水，按分值把 MEMORY.md 索引整段重建，'
      + '并归档超预算且非人工编辑的条目。它自己不从流水提炼内容 —— 提炼是蒸馏会话里模型经 memory_write 做的加法；'
      + '它也绝不重写任何条目正文 —— 索引只有一个写者，人手改过的内容蒸馏碰不得。'
      + '没有新日级时返回 no-op，重复调用无害（幂等靠水位线与加法协议）。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          outcome: { type: 'string', required: true },
          archived: { type: 'number', required: true },
          indexLines: { type: 'number', required: true },
          guardedSkips: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `蒸馏${value.outcome === 'no-op' ? '空跑（没有新日级）' : '完成'}：索引 ${value.indexLines} 行，`
          + `归档淘汰 ${value.archived} 条，手改保护跳过 ${value.guardedSkips} 条`,
      }],
    },
    async execute() {
      // 不带 promote：模型侧提炼发生在蒸馏会话自己的回合里（经 memory_write），这里只做
      // 确定性的重排/淘汰/重建/对账。把「提炼」也塞进一次工具调用会把两个写者焊回同一入口。
      const run = await distillOnce({ store, ledger: runLedger })
      return {
        outcome: run.outcome,
        archived: run.archived,
        indexLines: run.indexLines,
        guardedSkips: run.guardedSkips,
      }
    },
  })

  return { write, archive, distill }
}

/**
 * 夜间蒸馏的武装（设计 §3.5 DM7 / DM8，实现顺序第 5 步）。
 *
 * 蒸馏不是被谁「调用」的，是被内核 `schedule` 每天点名的：一条 recurring 的 `daily` 任务到点给
 * 蒸馏会话投一条用户消息，会话里的模型照消息行事。本模块负责三件事——
 * ①把「每晚 03:30 蒸一次」这条任务**幂等地**装出来（`ensureDistillArmed`），②给出那条消息的正文
 * （`DISTILL_PROMPT`），③在**蒸馏角色的**顶层会话出生时执行①（`installDistillArming`，第 6 步 A2 的监听半边；
 * 它只挂在 `index.ts` 的 `config.distiller` 分支上 —— 成员描述符连 `schedule` 都没注入，装不出武装）。
 *
 * 幂等靠 `daily/.distill-armed` 标记而不是调度层：内核 `schedule` **没有幂等键**（MF4），
 * 蒸馏进程每开一个顶层会话就会武装一次 recurring 任务，重启几次就一晚被叫醒好几次。重复蒸馏本身无害
 * （DM8 水位线让第二次拿到「没有新日级」而 no-op），但多条挂着的一日任务是多份打扰与多份账，
 * 且侧栏会挂着幽灵自动化（第 6 步要清零的那个观感问题的根）。读到非空标记即不再武装。
 *
 * MF5：**只有顶层会话能建定时任务**（子代理不能）。过滤由 `isTopLevelSession` 判、由
 * `installDistillArming` 在 `session/created` 监听里执行；即便漏判，内核也会在 `schedule.create`
 * 时拒绝子代理会话——监听器这层的过滤是让「不该发生的武装」连一次调用都不发生，而不是靠下游兜底。
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { MemoryStore } from './store.ts'

/**
 * 蒸馏时刻（本地挂钟，IANA 时区）。选 03:30 而不是整点：整点是所有自动化任务的拥挤时刻，
 * 错峰减少与审批催办/其他 daily 任务的连锁争抢。时区显式写死 `Asia/Shanghai` —— 内核要求
 * `daily` 带明确时区，且「夜间」对这台部署而言就是上海夜里。
 */
export const DISTILL_TIME = '03:30:00.000'
export const DISTILL_TIME_ZONE = 'Asia/Shanghai'

/** 任务名（内核限 120 字、会 trim，这里远未越界）。它出现在自动化任务列表与卡片标题里。 */
export const DISTILL_TITLE = '夜间记忆蒸馏'

/**
 * 投递给蒸馏会话正文 —— 这段是**模型当天唯一能看到的指令**（MF6：正文必须自包含，
 * 不能引用「上一条消息」之类会话内才有的东西），所以把四条纪律原文明写在里面：
 * - 单写者：索引 `MEMORY.md` 只由蒸馏整段重建，成员会话不碰（ME10）；这里也**不叫模型手写索引**，
 *   重建是确定性代码的活，模型只做「从流水里提炼新条目」。
 * - 加法：提炼新条目走 `memory_write`，绝不就地重写老条目（§3.2）。
 * - 不写凭据：正文里绝不出现明文密钥，只写它所在的环境变量名或位置指针（ME7）。
 * - 无新东西就什么都不做：水位线已覆盖到当天就直接结束，不要为了「跑一遍」而虚构条目（ME3 / ME11）。
 *
 * 措辞刻意用「提炼新条目并交给蒸馏机制重排索引」而非「重建 MEMORY.md」：后者会诱导模型直接
 * 编辑索引文件，与确定性重建抢同一个写者——正是第 3 步注入段守卫要防的那种双写。
 */
export const DISTILL_PROMPT = [
  '[平台夜间任务] 现在是记忆蒸馏时间。请按以下顺序处理，除此之外不要做任何事：',
  '1. 读取 memory 目录下 daily/ 里比上次水位线更新的日子，把其中**值得长期记住**的事实提炼成新条目：',
  '   用 memory_write 逐条新增（type 选 user/feedback/project/reference 之一，配 slug、标题、一句话钩子与正文）。',
  '2. 只新增，绝不就地重写或删除已有条目；已经记过的同一件事不要再记一遍——不确定就跳过。',
  '3. 条目正文与钩子里**绝不能出现明文密钥/令牌**，需要指代凭据时只写它所在的环境变量名或位置指针。',
  '4. 不要手写或重建 MEMORY.md 索引——索引由蒸馏机制按分值自动整段重建，你只管新增条目文件。',
  '5. 如果当天 daily 里没有值得长期记住的新东西，就什么都不做、直接结束，不要虚构记忆。',
].join('\n')

/** 武装端口：把「装一条每日任务」这件事抽象出来，测试用手动实现断言幂等，生产用 `ctx.schedule`。 */
export interface DistillAlarmPort {
  arm: (input: {
    sessionId: string
    title: string
    prompt: string
    time: string
    timeZone: string
  }) => Promise<string>
}

/**
 * 生产实现：`ctx.schedule.create` 的一条 `daily` 任务。
 *
 * 返回内核生成的 job id（字符串化），调用方把它写进 `daily/.distill-armed` 作为幂等标记。
 * 不用 `cron` 而用 `daily`：内核原生支持每日墙钟时刻且带显式时区（MF 记忆：dsh schedule 有 daily/cron），
 * `daily` 比五字段 cron 更难写错，也不需要我们再校验表达式。
 */
export function createScheduleDistillAlarms(ctx: Context): DistillAlarmPort {
  return {
    async arm(input) {
      const record = await ctx.schedule.create(SessionId(input.sessionId), {
        title: input.title,
        prompt: input.prompt,
        daily: { time: input.time, time_zone: input.timeZone },
      })
      return String(record.id)
    },
  }
}

export interface ArmOutcome {
  /** `true` = 本次真的装出了一条新任务；`false` = 已有标记，跳过（幂等命中）。 */
  readonly armed: boolean
  /** 生效的任务 id：本次武装的是新装的，命中的是标记里存的那个。 */
  readonly jobId: string
}

/**
 * 幂等地武装夜间蒸馏：已有非空标记直接返回，不重复调 `arm`。
 *
 * 顺序是「读标记 → 没有才 arm → arm 成功才写标记」：反过来（先写标记再 arm）会在 arm 抛错时
 * 留下一个指向不存在任务的标记，于是这一夜**永远**再也不会被武装。标记读不到（首夜或丢失）
 * 当「没有」处理——多装一条 recurring 任务能被下一轮的幂等收回，漏装才是真故障。
 */
export async function ensureDistillArmed(
  store: MemoryStore,
  port: DistillAlarmPort,
  options: { sessionId: string, time?: string, timeZone?: string, title?: string },
): Promise<ArmOutcome> {
  const existing = await store.readArmedJob()
  if (existing !== undefined) return { armed: false, jobId: existing }
  const jobId = await port.arm({
    sessionId: options.sessionId,
    title: options.title ?? DISTILL_TITLE,
    prompt: DISTILL_PROMPT,
    time: options.time ?? DISTILL_TIME,
    timeZone: options.timeZone ?? DISTILL_TIME_ZONE,
  })
  await store.writeArmedJob(jobId)
  return { armed: true, jobId }
}

/**
 * MF5：这条会话是不是**顶层会话** —— 只有顶层会话能建定时任务，子代理的会话装进去会被内核拒绝
 * （`schedule.create` 对 delegation depth 大于 0 的目标回 `subagent_session`），拒绝发生在夜里
 * 投递之前，白丢一次武装。判定只看 header：`parentSession` 缺席且 `origin !== 'subagent'`。
 *
 * 入参刻意是最小的结构类型而不是内核的 `Session`：header 的两个字段在这里只当**判别量**用，
 * 单元测试就能拿合成对象把表跑全，不必造真会话。
 */
export function isTopLevelSession(session: {
  readonly header?: { readonly parentSession?: unknown, readonly origin?: unknown }
}): boolean {
  return session.header?.parentSession === undefined && session.header?.origin !== 'subagent'
}

/**
 * 把「顶层会话一出现就幂等地武装夜间蒸馏」挂到 `session/created` 上（§7 第 6 步 A2）。
 *
 * 为什么挂在会话出生而不是进程启动：蒸馏会话本身就是被 `schedule` 叫醒而创建的会话，
 * 顶层会话出现是「这台部署真的在用」的信号，武装因此跟着使用发生，而不是跟着开机猜测。
 * 监听器必须是同步的（`session/created` 的同步抛出会回滚会话发布），所以武装是 fire-and-forget：
 * 成败都只留日志。幂等不在这里重复实现 —— `ensureDistillArmed` 读 `daily/.distill-armed` 标记，
 * 每个进程顶多装出一条 recurring 任务，重启与多个顶层会话都命中同一标记。
 *
 * @returns 监听器的释放函数，交给装配层的合并 disposer。
 */
export function installDistillArming(ctx: Context, store: MemoryStore, port: DistillAlarmPort): () => void {
  const logger = ctx.logger('office-memory')
  return ctx.on('session/created', (session) => {
    if (!isTopLevelSession(session)) return
    void ensureDistillArmed(store, port, { sessionId: String(session.id) })
      .then(outcome => logger.info(outcome.armed
        ? `夜间蒸馏已武装：会话 ${session.id}，任务 ${outcome.jobId}`
        : `夜间蒸馏早已武装（命中标记）：任务 ${outcome.jobId}`))
      .catch((error: unknown) => logger.warn(`夜间蒸馏武装失败 ${session.id}: ${String(error)}`))
  })
}

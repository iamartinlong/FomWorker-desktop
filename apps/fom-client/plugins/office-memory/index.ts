/**
 * 记忆层的挂载入口（设计 §3.1 / §3.5 DM7，第 6 步 A2 的角色组合）。
 *
 * 同一份 `apply` 服务两个角色，由 `config.distiller` 决定接哪半边线：
 * - **成员角色**（默认）：两把写工具 + 常驻索引段。不装 `memory_distill`、不开台账域、不碰
 *   `schedule` —— 成员进程多一个服务依赖就多一分「配不齐就不装」的失败面，而成员根本不需要蒸馏线。
 * - **蒸馏角色**：再加 `memory_distill` 一把（要 `office_memory_run` 台账落对账行）与
 *   `session/created` 武装监听（要 `schedule` 建每日任务，MF5 只放顶层会话）。
 *
 * `memoryRoot` 为空**直接抛**，不静默不装：跟审批层「配了 App ID 却没 Secret」同一取向 ——
 * 装了一半的记忆层会让台账看起来像「记忆已经记上了」，而实际一个字都没落盘。
 * 抛出去之后整层不装，内核自带的行为照旧，那是「没有长期记忆」，不是「放宽了守卫」。
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MemoryStore } from './store.ts'
import { createMemoryTools } from './tools.ts'
import { createIndexText } from './inject.ts'
import { memoryRunDomain, MemoryRunLedger } from './run-ledger.ts'
import { createScheduleDistillAlarms, installDistillArming } from './arm.ts'

/**
 * 常驻索引段在 system prompt 里的位置。内核保留命名槽（persona=0，plan 政策=500），
 * 400 落在两者之间的空档：索引该在可复用的产品指令之后、具体工具说明之前被读到。
 */
const MEMORY_SECTION_ORDER = 400

export interface OfficeMemoryConfig {
  /**
   * 记忆目录的绝对路径（DM2 那棵树的家）。
   *
   * 必须是绝对路径：启动器的 cwd 在内核仓库里，相对路径会把记忆写进内核工作树，
   * 违反「内核零改动」。蒸馏进程那一侧这个值就是它的 `workspaceRoot`（DM7）。
   */
  memoryRoot: string
  /**
   * 本进程是否担任**蒸馏角色**。必须与挂载的描述符配对（见文件末尾两份导出的注释）：
   * 蒸馏进程用 `distiller.ts` 入口 + `distiller: true`；成员进程两者都不出现。
   */
  distiller: boolean
}

/** 形状抄 `office-approval/index.ts`：`z<Config>` 标注 + `z.object` 取值。 */
const Config: z<OfficeMemoryConfig> = z.object({
  memoryRoot: z.string().default(''),
  distiller: z.boolean().default(false),
})

export async function apply(ctx: Context, config: OfficeMemoryConfig): Promise<() => void> {
  if (config.memoryRoot === '') {
    throw new Error('office-memory: memoryRoot 是空的（必须是记忆目录的绝对路径）')
  }
  if (config.distiller
    && (ctx.get('storageDomain') === undefined || ctx.get('schedule') === undefined || ctx.get('sessions') === undefined)) {
    // 成员描述符 + `distiller: true` 是最危险的误配：apply 会去开台账域、装每日任务，
    // 而这些服务在成员拓扑里没有任何加载顺序保证（首个会话可能早于插件就绪 ⇒ 永远不武装）。
    // 与其让部署悄悄拿到一个「半装」的蒸馏进程，不如在这里响亮地拒绝（§「误配在最早可判定点失败」）。
    throw new Error('office-memory: distiller: true 必须配 OfficeMemoryDistiller 挂载（见 plugins/office-memory/distiller.ts），成员描述符不注入 storageDomain / schedule / sessions')
  }
  const store = new MemoryStore(config.memoryRoot)
  const indexText = createIndexText(store)
  const releases: (() => void)[] = []

  if (config.distiller) {
    // 蒸馏角色：台账 + 三把工具 + 顶层会话的夜间武装监听。`installDistillArming` 的幂等
    // 在 `ensureDistillArmed` 的标记里，这里只负责「装上」与「随 disposer 卸下」。
    const ledger = new MemoryRunLedger(await ctx.storageDomain.open(memoryRunDomain))
    const tools = createMemoryTools(store, ledger)
    releases.push(
      ctx.tools.register(tools.write),
      ctx.tools.register(tools.archive),
      ctx.tools.register(tools.distill),
      installDistillArming(ctx, store, createScheduleDistillAlarms(ctx)),
    )
  } else {
    // 成员角色：只装两把写工具。`createMemoryTools(store)` 不带台账 ⇒ 压根构造不出
    // `memory_distill`，「成员不注册蒸馏工具」不是约定而是类型事实。
    const tools = createMemoryTools(store)
    releases.push(
      ctx.tools.register(tools.write),
      ctx.tools.register(tools.archive),
    )
  }

  releases.push(ctx.systemPrompt.section({
    name: 'office-memory',
    order: MEMORY_SECTION_ORDER,
    // provider 形态：每次装配重新读磁盘上的 MEMORY.md（MF12），改了索引不重启、下一回合即见。
    text: indexText,
    // 关掉插值：记忆条目可能含字面 `{{ }}`，不能被当成模板变量替换掉（内核对未定义引用会抛）。
    interpolate: false,
  }))
  ctx.logger('office-memory').info(config.distiller
    ? `记忆层已装配（蒸馏角色）：目录 ${store.root}，工具 memory_write / memory_archive / memory_distill + 常驻索引段 + 夜间武装监听`
    : `记忆层已装配（成员角色）：目录 ${store.root}，工具 memory_write / memory_archive + 常驻索引段`)
  return () => {
    for (const release of releases) release()
  }
}

/**
 * 角色与 `inject` 的关系：cordis 的 `inject` 每一项都是**必需**服务（服务不齐就不加载插件，
 * `vendor/cordis/src/registry.ts:105-106`），而它是在 `apply` 之前被读的 —— 同一份
 * `inject` 不可能按 `config.distiller` 伸缩。所以两个角色是两份描述符：
 *
 * - `OfficeMemory`（成员，默认导出）：只必需 `tools` + `systemPrompt`。成员进程因此可以装进
 *   任何没有 schedule/storage-domain 拓扑的部署而不加载 —— 那是「没有夜间蒸馏」，不是「放宽了守卫」。
 * - `OfficeMemoryDistiller`（蒸馏）：额外必需 `storageDomain` / `schedule` / `sessions`
 *   （台账、每日任务、会话事件拓扑）。`--patch` 取模块**默认导出**（`vendor/loader/src/index.ts:203`），
 *   所以蒸馏进程经 `./plugins/office-memory/distiller.ts` 挂载 —— 那个入口的默认导出是本描述符。
 *
 * 描述符与 `distiller: true` 是同一事实的两半，必须一起出现：描述符决定服务可用性，`distiller`
 * 决定 `apply` 接哪半边线；错配由 `apply` 开头的显式抛接住（成员拓扑挂蒸馏配置）或响亮地
 * 不加载（蒸馏拓扑缺服务）。
 */
export const OfficeMemory = {
  name: 'office-memory',
  inject: ['tools', 'systemPrompt'],
  Config,
  apply,
}

/** 蒸馏角色的描述符：`inject` 是成员那份 + 台账/调度/会话三个必需服务；`apply` 同一份。 */
export const OfficeMemoryDistiller = {
  name: 'office-memory',
  inject: ['tools', 'systemPrompt', 'storageDomain', 'schedule', 'sessions'],
  Config,
  apply,
}

export default OfficeMemory

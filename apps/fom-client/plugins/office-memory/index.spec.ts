/**
 * 装配入口的角色门控验收（设计 §3.5 DM7 双进程、§7 第 6 步 A2）。
 *
 * 这里跑的是**真挂载**：`ctx.plugin(descriptor, config)` 走 cordis 的 inject 就绪判定与
 * `Config` 校验，工具注册进真 `ToolRuntime`。单元地调 `apply` 证明不了「成员描述符不
 * 必需 schedule/storageDomain」这句话 —— 只有把成员挂载放进**没有** schedule 的组合里
 * 还能装上、而蒸馏角色缺服务时那条线压根不接，才算验过。
 *
 * 武装半边用真 `schedule`（`boot({ schedule: true })` 的内核服务）：顶层会话出生 ⇒
 * `session/created` ⇒ `ensureDistillArmed` 经真端口装出每日任务并把 job id 落进标记。
 * 判据取标记与 `schedule.list` 的任务，不取日志。子代理过滤与幂等由 `arm.spec.ts` 的
 * 手动端口逐条断言；这一层只证明「接上去的那条线是通的」。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { apply, OfficeMemory, OfficeMemoryDistiller } from './index.ts'
import DistillerEntry from './distiller.ts'
import { MemoryStore } from './store.ts'
import { DISTILL_TITLE } from './arm.ts'
import { boot, sleep } from '../office-approval/test-harness.ts'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function newMemoryRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'office-memory-index-'))
  dirs.push(dir)
  return join(dir, 'memories')
}

/** 轮询武装标记（fire-and-forget 监听 ⇒ 只能等，不能猜时长）。 */
async function waitForArmed(store: MemoryStore, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const jobId = await store.readArmedJob()
    if (jobId !== undefined) return jobId
    if (Date.now() > deadline) throw new Error('顶层会话出生 5 秒后武装标记仍不存在')
    await sleep(20)
  }
}

describe('蒸馏描述符挂载（distiller: true）', () => {
  it('三把工具注册齐全，顶层会话出生经真 schedule 装出每日蒸馏任务', async () => {
    const setup = await boot({ schedule: true })
    const memoryRoot = await newMemoryRoot()
    await setup.ctx.plugin(OfficeMemoryDistiller, { memoryRoot, distiller: true })

    expect(setup.ctx.tools.get('memory_write')).toBeDefined()
    expect(setup.ctx.tools.get('memory_archive')).toBeDefined()
    // 蒸馏角色才有第三把：它过同一条闸（字典 L1），夜里零张卡（ME8）。
    expect(setup.ctx.tools.get('memory_distill')).toBeDefined()

    setup.ctx.sessions.create(SessionId('asm-top-1'))
    const store = new MemoryStore(memoryRoot)
    expect(await waitForArmed(store)).toBeTypeOf('string')

    // 任务真的落在内核 schedule 里，且绑的是那个顶层会话、形态是 daily。
    const tasks = await setup.ctx.schedule.list({ sessionId: SessionId('asm-top-1') })
    expect(tasks.filter(t => t.title === DISTILL_TITLE && t.kind === 'daily')).toHaveLength(1)

    // 第二个顶层会话命中 `daily/.distill-armed` 标记 ⇒ 不再装出第二条任务（MF4 无幂等键的防线）。
    setup.ctx.sessions.create(SessionId('asm-top-2'))
    await sleep(100)
    const tasks2 = await setup.ctx.schedule.list({ sessionId: SessionId('asm-top-2') })
    expect(tasks2).toHaveLength(0)
  })

  it('distiller: true 配成员描述符（无 schedule 拓扑）⇒ 响亮地抛，不装半个蒸馏进程', async () => {
    const setup = await boot()
    const memoryRoot = await newMemoryRoot()
    await expect(setup.ctx.plugin(OfficeMemory, { memoryRoot, distiller: true }))
      .rejects.toThrow(/distiller: true/)
  })
})

describe('成员描述符挂载（默认角色）', () => {
  it('没有 schedule 的组合里照样装上：只两把工具，memory_distill 不存在', async () => {
    // 这一句是被断言的事实本身：`boot()` 没挂 `schedule`，成员若必需它就连 inject 都过不了；
    // 而「装上了但没有第三把」排除了「靠 config 忘了关掉」的挂载形态。
    const setup = await boot()
    const memoryRoot = await newMemoryRoot()
    await setup.ctx.plugin(OfficeMemory, { memoryRoot, distiller: false })

    expect(setup.ctx.tools.get('memory_write')).toBeDefined()
    expect(setup.ctx.tools.get('memory_archive')).toBeDefined()
    expect(setup.ctx.tools.get('memory_distill')).toBeUndefined()
  })

  it('成员侧顶层会话出生不武装：监听器压根没装', async () => {
    const setup = await boot()
    const memoryRoot = await newMemoryRoot()
    await setup.ctx.plugin(OfficeMemory, { memoryRoot, distiller: false })

    setup.ctx.sessions.create(SessionId('asm-member-top'))
    await sleep(100)
    expect(await new MemoryStore(memoryRoot).readArmedJob()).toBeUndefined()
  })
})

describe('蒸馏入口 `distiller.ts` 的默认导出（`--patch` 实际取的就是这一份）', () => {
  it('经入口挂载 ⇒ 装出蒸馏角色；它必需的那三个服务是角色拆分的全部依据', async () => {
    // `--patch` 的装载取模块**默认导出**（`vendor/loader/src/index.ts:203` `unwrapExports`），
    // 所以这个文件导出的那份描述符就是部署事实：把它改回成员份，`distiller: true` 会在 `apply`
    // 开头响亮地抛（上面那条用例验的就是这半），蒸馏进程压根装不出来 —— 夜里没人蒸，且是配了才响。
    const setup = await boot({ schedule: true })
    const memoryRoot = await newMemoryRoot()
    await setup.ctx.plugin(DistillerEntry, { memoryRoot, distiller: true })
    expect(setup.ctx.tools.get('memory_distill')).toBeDefined()
    expect(DistillerEntry.inject).toEqual(
      expect.arrayContaining(['tools', 'systemPrompt', 'storageDomain', 'schedule', 'sessions']))
  })
})

describe('config 的空值守卫：memoryRoot 不许是空串', () => {
  it('空串 memoryRoot ⇒ 拒绝挂载，一把工具都不注册', async () => {
    // `Config.memoryRoot` 的默认值就是空串，所以「patch 里漏写 memoryRoot」是必然会发生的形状，
    // 不是假设。放过去会得到 `MemoryStore('')` —— 相对路径按进程 cwd 解析，启动器的 cwd 在内核仓库根，
    // 于是记忆直接写进 `deepseek-harness/` 的工作树，违反的是「内核零改动」这条铁律本身。
    // 守卫必须排在注册工具之前，所以这里既断「抛」也断「什么都没装上」。
    const setup = await boot()
    await expect(setup.ctx.plugin(OfficeMemory, { memoryRoot: '', distiller: false }))
      .rejects.toThrow(/memoryRoot/)
    expect(setup.ctx.tools.get('memory_write')).toBeUndefined()
    expect(setup.ctx.tools.get('memory_archive')).toBeUndefined()
  })

  it('蒸馏角色同样先过这道守卫（空 memoryRoot 连台账域都不该开）', async () => {
    const setup = await boot({ schedule: true })
    await expect(setup.ctx.plugin(OfficeMemoryDistiller, { memoryRoot: '', distiller: true }))
      .rejects.toThrow(/memoryRoot/)
    expect(setup.ctx.tools.get('memory_distill')).toBeUndefined()
  })
})

describe('disposer：释放即全部拆干净', () => {
  it('蒸馏角色 release 后三把工具注销、武装监听摘除', async () => {
    const setup = await boot({ schedule: true })
    const memoryRoot = await newMemoryRoot()
    const release = await apply(setup.ctx, { memoryRoot, distiller: true })
    expect(setup.ctx.tools.get('memory_distill')).toBeDefined()

    release()
    expect(setup.ctx.tools.get('memory_write')).toBeUndefined()
    expect(setup.ctx.tools.get('memory_archive')).toBeUndefined()
    expect(setup.ctx.tools.get('memory_distill')).toBeUndefined()

    // 监听器必须随 disposer 摘除：之后又来顶层会话，也不再武装。
    setup.ctx.sessions.create(SessionId('asm-after-release'))
    await sleep(100)
    expect(await new MemoryStore(memoryRoot).readArmedJob()).toBeUndefined()
  })
})

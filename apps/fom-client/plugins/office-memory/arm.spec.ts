/**
 * 夜间蒸馏武装的验收单测（§7 第 5 步）。断言两件事：
 * - **幂等靠标记**：已有非空 `daily/.distill-armed` ⇒ 不再调 `port.arm`（防重启堆叠 recurring 任务）；
 *   标记丢失 ⇒ 重新武装；`arm` 抛错 ⇒ **不写标记**（否则留下指向不存在任务的标记，这一夜永不复装）。
 * - **正文纪律**：`DISTILL_PROMPT` 自包含地写进四条不能违反的约束（单写者 / 加法 / 不写凭据 / 不虚构），
 *   因为它是模型当天唯一能看到的指令，措辞是产品承诺而非装饰。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { MemoryStore } from './store.ts'
import {
  DISTILL_PROMPT, DISTILL_TIME, DISTILL_TIME_ZONE, DISTILL_TITLE,
  ensureDistillArmed, installDistillArming, isTopLevelSession, type DistillAlarmPort,
} from './arm.ts'
import { boot, sleep, until } from '../office-approval/test-harness.ts'

const CLOCK = new Date('2026-10-10T09:00:00Z').getTime()
const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function newStore(): Promise<MemoryStore> {
  const dir = await mkdtemp(join(tmpdir(), 'office-arm-'))
  roots.push(dir)
  return new MemoryStore(join(dir, 'memories'), { now: () => CLOCK })
}

/** 记录每次 arm 调用（含入参）、可返回固定 job id 或抛错的手动端口。 */
function fakePort(): DistillAlarmPort & {
  calls: number
  inputs: Parameters<DistillAlarmPort['arm']>[0][]
  fail?: Error
  id?: string
} {
  return {
    calls: 0,
    inputs: [],
    async arm(input) {
      this.calls += 1
      this.inputs.push(input)
      if (this.fail !== undefined) throw this.fail
      return this.id ?? `job-${this.calls}`
    },
  }
}

describe('ensureDistillArmed：幂等靠标记', () => {
  it('首次武装调 port.arm 并写标记；再次调用命中 ⇒ 不再 arm', async () => {
    const store = await newStore()
    const port = fakePort()
    const first = await ensureDistillArmed(store, port, { sessionId: 'top-session-1' })
    expect(first.armed).toBe(true)
    expect(first.jobId).toBe('job-1')
    expect(port.calls).toBe(1)

    const second = await ensureDistillArmed(store, port, { sessionId: 'top-session-1' })
    expect(second.armed).toBe(false)
    expect(second.jobId).toBe('job-1')
    expect(port.calls).toBe(1)
    // 标记读得回来
    expect(await store.readArmedJob()).toBe('job-1')
  })

  it('arm 抛错 ⇒ 不写标记，下次仍能重武装（漏装是真故障，标记不能跑在任务前面）', async () => {
    const store = await newStore()
    const port = fakePort()
    port.fail = new Error('schedule rejected')
    await expect(ensureDistillArmed(store, port, { sessionId: 'top-session-1' })).rejects.toThrow(/schedule rejected/)
    expect(await store.readArmedJob()).toBeUndefined()

    // 去掉故障后重试 ⇒ 成功武装
    port.fail = undefined
    const retry = await ensureDistillArmed(store, port, { sessionId: 'top-session-1' })
    expect(retry.armed).toBe(true)
  })

  it('用 daily 时刻与时区默认值（错峰 03:30 / Asia/Shanghai）', async () => {
    const store = await newStore()
    expect(DISTILL_TIME).toBe('03:30:00.000')
    expect(DISTILL_TIME_ZONE).toBe('Asia/Shanghai')
    await ensureDistillArmed(store, fakePort(), { sessionId: 'top' })
    expect(await store.readArmedJob()).toBeDefined()
  })
})

describe('DISTILL_PROMPT：四条纪律写进正文', () => {
  const text = DISTILL_PROMPT
  it('单写者：明令不要手写/重建 MEMORY.md', () => {
    expect(text).toContain('MEMORY.md')
    expect(text).toMatch(/不要手写|不要.*重建.*索引/)
  })
  it('加法：只新增，绝不就地重写或删除已有条目', () => {
    expect(text).toMatch(/只新增/)
    expect(text).toMatch(/绝不就地重写/)
  })
  it('不写凭据：正文与钩子绝不出现明文密钥，只写环境变量名/位置指针', () => {
    expect(text).toMatch(/绝不能出现明文密钥/)
    expect(text).toMatch(/环境变量名/)
  })
  it('不虚构：没有新东西就什么都不做（ME11）', () => {
    expect(text).toMatch(/不要虚构记忆/)
  })
})

// MF5（第 6 步 A2）：只有顶层会话能建定时任务。过滤住子代理不是「省一次报错」——
// 而是让内核根本收不到一次注定被 `subagent_session` 拒绝的武装请求。
describe('isTopLevelSession：顶层判定的纯函数表（MF5）', () => {
  const cases: Array<[string, { header?: { parentSession?: string, origin?: string } }, boolean]> = [
    ['无 header（合成最小对象）= 顶层', {}, true],
    ['空 header = 顶层', { header: {} }, true],
    ['显式 undefined 两字段 = 顶层', { header: { parentSession: undefined, origin: undefined } }, true],
    ['parentSession 在场 = 非顶层（fork 血脉）', { header: { parentSession: 'sess-parent' } }, false],
    ['origin=subagent = 非顶层（委派子会话）', { header: { origin: 'subagent' } }, false],
    ['两形齐全 = 非顶层', { header: { parentSession: 'sess-parent', origin: 'subagent' } }, false],
  ]
  cases.forEach(([label, session, expected]) => it(label, () => {
    expect(isTopLevelSession(session)).toBe(expected)
  }))
})

describe('installDistillArming：session/created 监听 + MF5 过滤 + disposer 摘除', () => {
  /** 武装标记落在 `daily/.distill-armed`（`store.ts` 的 ARMED_PATH）；删它模拟「标记丢失」。 */
  const armedMarker = (store: MemoryStore): string => join(store.root, 'daily', '.distill-armed')

  it('子代理/带父会话不武装；顶层武装一次；标记令第二个顶层会话幂等；release 后监听器消失', async () => {
    const setup = await boot()
    const store = await newStore()
    const port = fakePort()
    const release = installDistillArming(setup.ctx, store, port)

    // 非顶层两形：监听器过滤在调用之前，port 连一次都不该见。
    setup.ctx.sessions.create(SessionId('arm-sub-origin'), { meta: { origin: 'subagent' } })
    setup.ctx.sessions.create(SessionId('arm-sub-parent'), { meta: { parentSession: SessionId('arm-root') } })
    await sleep(100)
    expect(port.calls).toBe(0)

    // 顶层 ⇒ 装出一次，入参是那条会话与 03:30/Asia-Shanghai 常量。
    setup.ctx.sessions.create(SessionId('arm-top-1'))
    await until(() => port.calls === 1, '顶层会话出生没有触发武装')
    expect(port.inputs[0]).toMatchObject({
      sessionId: 'arm-top-1',
      title: DISTILL_TITLE,
      prompt: DISTILL_PROMPT,
      time: DISTILL_TIME,
      timeZone: DISTILL_TIME_ZONE,
    })
    // `port.arm` 返回后标记才落盘（`ensureDistillArmed` 的收尾），所以这里轮询而不是立即断言。
    const markerDeadline = Date.now() + 5_000
    while (await store.readArmedJob() === undefined) {
      if (Date.now() > markerDeadline) throw new Error('武装成功 5 秒后标记仍没写上')
      await sleep(20)
    }

    // 幂等归 `ensureDistillArmed` 的标记管：第二个顶层会话命中，port 不涨。
    setup.ctx.sessions.create(SessionId('arm-top-2'))
    await sleep(100)
    expect(port.calls).toBe(1)

    // disposer：监听器必须随释放摘除 —— 之后即便标记丢失、又来顶层会话，也不再装。
    release()
    await rm(armedMarker(store), { force: true })
    setup.ctx.sessions.create(SessionId('arm-top-3'))
    await sleep(100)
    expect(port.calls).toBe(1)
  })
})

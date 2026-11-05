/**
 * 归档的**顺序**证据（设计 §3.2：先撤索引，后移文件）。
 *
 * 成功路径上两种顺序看不出区别，所以这里只伪造一件事：让 `rename` 失败一次。
 * 于是能观察到「此刻索引里还有没有那条指向原址的链接」—— 而那正是两种顺序的分岔点：
 * 先移文件的话，索引会留下一条永远打不开的链接；先撤索引则最多暂时看不见一个还在原址的文件。
 *
 * 伪造的方式与审批层 `test-harness.ts` 的 `rejectingBackend` 同一取向：只包一个操作，
 * 其余全部走真的 `node:fs/promises`，被测对象仍然是那份真文件行为。
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const state = vi.hoisted(() => ({ renameBroken: false }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (state.renameBroken) {
        const error = new Error('EBUSY: resource busy or locked (simulated)') as NodeJS.ErrnoException
        error.code = 'EBUSY'
        throw error
      }
      return await actual.rename(from, to)
    },
  }
})

const { MemoryStore } = await import('./store.ts')

const CLOCK = new Date('2026-10-10T09:00:00').getTime()
const dirs: string[] = []

afterEach(async () => {
  state.renameBroken = false
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('归档失败的一刻：索引已经撤了，文件还在原址', () => {
  it('rename 失败 ⇒ 报出此刻的不一致，并且不留悬空索引；放开后重试成功', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'office-memory-order-'))
    dirs.push(dir)
    const store = new MemoryStore(join(dir, 'memories'), { now: () => CLOCK })
    await store.writeEntry({
      type: 'project', slug: 'q4-report', title: 'Q4 报告', hook: '结论先出',
      body: '老板要的是先给结论。', source: 'session',
    })
    const index = join(dir, 'memories', 'MEMORY.md')
    await writeFile(index, '# 记忆索引\n\n- [Q4 报告](project/q4-report.md) — 结论先出\n- [别的](user/other.md) — 不关它的事\n', 'utf8')

    state.renameBroken = true
    const failure = await store.archiveEntry('project/q4-report.md', '已结项').then(() => undefined, (e: unknown) => e as Error)
    expect(failure?.message).toContain('归档移动失败')

    // 这一行就是顺序的判据：移动失败的那一刻，索引里**已经**没有这条链接了。
    expect(await readFile(index, 'utf8')).not.toContain('project/q4-report.md')
    // 而文件没丢，还在原址 —— 所以「暂时看不见」而不是「永久指空」。
    expect(await readFile(join(dir, 'memories', 'project', 'q4-report.md'), 'utf8')).toContain('先给结论')
    expect(await readFile(index, 'utf8')).toContain('user/other.md')

    state.renameBroken = false
    const retry = await store.archiveEntry('project/q4-report.md', '已结项')
    expect(retry.archivedTo).toBe('archived/2026/project-q4-report.md')
    expect(await readFile(join(dir, 'memories', retry.archivedTo), 'utf8')).toContain('先给结论')
  })
})

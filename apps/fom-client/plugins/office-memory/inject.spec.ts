/**
 * 常驻索引段的验收单测（设计 §7 第 3 步：ME1 / ME5 / ME7 注入侧 / ME10 引导 / F-L）。
 *
 * `buildIndexBlock` 是纯函数，逐条断言三条守卫的**形状**；`createIndexText` 那半只多一件事：
 * 同步读磁盘 + 异步往 `daily` 留痕（不静默丢，且按内容去重、一夜一次）。留痕是 fire-and-forget，
 * 所以判据用轮询（M1 审批层同一条纪律：别读未落盘的中间态）。
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from './store.ts'
import { DEFAULT_BUDGET, READ_SIDE_GUIDANCE, buildIndexBlock, createIndexText } from './inject.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** 一行 DM2 形状的索引条目。 */
const line = (type: string, slug: string, hook = '钩子'): string => `- [${type}-${slug}](${type}/${slug}.md) — ${hook}`

async function newStore(): Promise<{ store: MemoryStore, dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'office-memory-'))
  roots.push(dir)
  const store = new MemoryStore(join(dir, 'memories'))
  await mkdir(join(dir, 'memories'), { recursive: true })
  return { store, dir }
}

async function writeIndex(dir: string, text: string): Promise<void> {
  await writeFile(join(dir, 'memories', 'MEMORY.md'), text, 'utf8')
}

async function readDaily(store: MemoryStore, dir: string): Promise<string> {
  // 用 store 自己的 dailyPath()（本地挂钟），别用 UTC 派生的日期 —— 本机时区下两者跨零点会差一天。
  return await readFile(join(dir, 'memories', store.dailyPath()), 'utf8').catch(() => '')
}

/** 轮询到谓词成立再断言：留痕是异步的，直接读会读到没落盘的中间态。 */
async function until(predicate: () => Promise<boolean>): Promise<boolean> {
  for (let i = 0; i < 100; i += 1) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return false
}

describe('buildIndexBlock：常驻段的三条守卫', () => {
  it('没有记忆就不注入空段（ME10）', () => {
    expect(buildIndexBlock('').block).toBe('')
    expect(buildIndexBlock('# 记忆索引\n\n').block).toBe('')
  })

  it('非空时是「标题 + 条目原行 + 读侧引导」，条目正文不进段（§3.4 按需 read）', () => {
    const raw = `# 记忆索引\n\n${line('project', 'a', '项目甲')}\n${line('reference', 'b', '看板在 X')}\n`
    const { block } = buildIndexBlock(raw)
    expect(block).toContain('## 长期记忆索引（常驻）')
    expect(block).toContain(line('project', 'a', '项目甲'))
    expect(block).toContain(READ_SIDE_GUIDANCE)
  })

  it('预算超限：条目裁到 ≤maxLines 且不静默丢（ME1）', () => {
    const raw = Array.from({ length: 300 }, (_, i) => line('project', `p${i}`)).join('\n')
    const { block, trimmed } = buildIndexBlock(raw, { maxLines: 200, maxBytes: 4096 })
    const entryLines = block.split('\n').filter(l => l.startsWith('- ['))
    expect(entryLines.length).toBeLessThanOrEqual(200)
    expect(Buffer.byteLength(block, 'utf8')).toBeLessThanOrEqual(4096)
    expect(trimmed.length).toBeGreaterThan(0)
    // 被裁的行确实没进段。
    expect(block).not.toContain(trimmed[0]!)
  })

  it('超预算时按类型权重裁，老 feedback 不被新鲜 reference 挤掉（ME5）', () => {
    // 权重：feedback(3) > reference(1)。60 天前这条 feedback 也必须留住（注入侧只看权重，不看时间）。
    const raw = [
      line('feedback', 'keep', '重要纠正'),
      ...Array.from({ length: 10 }, (_, i) => line('reference', `r${i}`)),
    ].join('\n')
    const { block, trimmed } = buildIndexBlock(raw, { maxLines: 3, maxBytes: 1_000_000 })
    expect(block).toContain(line('feedback', 'keep', '重要纠正'))
    expect(trimmed.every(l => !l.includes('feedback/'))).toBe(true)
    expect(block.split('\n').filter(l => l.startsWith('- ['))).toHaveLength(3)
  })

  it('注入侧再跑一遍黑名单：命中凭据的行不进段（ME7）', () => {
    const secretHook = line('reference', 'leak', 'token sk-abcdefghijklmno0123456789')
    const raw = [line('project', 'ok', '正常条目'), secretHook].join('\n')
    const { block, deniedCount } = buildIndexBlock(raw, DEFAULT_BUDGET)
    expect(deniedCount).toBe(1)
    expect(block).toContain('正常条目')
    expect(block).not.toContain('sk-abcdefghijklmno0123456789')
  })

  it('引导文案点名「索引由夜间蒸馏整段重写 / 别手补 / 别虚构」——这是产品承诺，必须被断言（ME10 / ME11 / F-L）', () => {
    expect(READ_SIDE_GUIDANCE).toContain('夜间蒸馏')
    expect(READ_SIDE_GUIDANCE).toContain('整段重写')
    expect(READ_SIDE_GUIDANCE).toContain('不要自己编辑')
    expect(READ_SIDE_GUIDANCE).toContain('不要虚构')
  })

  it('条目里的字面花括号原样保留（配合 section 的 interpolate:false，不被当模板变量）', () => {
    const raw = line('reference', 'tpl', '占位符写成 {{env_name}} 形态')
    expect(buildIndexBlock(raw).block).toContain('{{env_name}}')
  })
})

describe('createIndexText：同步 provider + daily 留痕（按内容去重）', () => {
  it('索引超预算 → provider 返回受控段，被裁行落进 daily，且同一份索引只记一次', async () => {
    const { store, dir } = await newStore()
    const raw = Array.from({ length: 260 }, (_, i) => line('reference', `r${i}`)).join('\n')
    await writeIndex(dir, raw)
    const provider = createIndexText(store, { budget: { maxLines: 5, maxBytes: 1_000_000 } })

    const block = provider()
    expect(block).toContain('## 长期记忆索引')
    const recorded = await until(async () => (await readDaily(store, dir)).includes('超预算'))
    expect(recorded).toBe(true)
    const firstDaily = await readDaily(store, dir)
    expect(firstDaily).toContain('未进本回合注入段')

    // 再调两次（同一份索引）：去重生效，daily 不该被同一件事刷三遍。
    provider()
    provider()
    const stillOnce = await until(async () => (await readDaily(store, dir)).split('超预算').length - 1 === 1)
    expect(stillOnce).toBe(true)
  })

  it('命中黑名单的行：daily 只记计数，绝不落进行内容', async () => {
    const { store, dir } = await newStore()
    await writeIndex(dir, line('reference', 'leak', 'x-access-token 头的值是 abcdef0123456789'))
    const provider = createIndexText(store)

    const block = provider()
    expect(block).toBe('') // 唯一条目被拒 → 段空
    const recorded = await until(async () => (await readDaily(store, dir)).includes('已拒'))
    expect(recorded).toBe(true)
    const daily = await readDaily(store, dir)
    expect(daily).not.toContain('x-access-token')
    expect(daily).not.toContain('abcdef0123456789')
  })

  it('没记忆 → provider 返回空串，什么都不落（空段被内核 renderPrompt 丢弃）', async () => {
    const { store } = await newStore()
    expect(createIndexText(store)()).toBe('')
  })
})

/**
 * 本地模式标记的宿主侧读写验收：写到宿主后，平台插件读同一个文件决定降频。
 *
 * 为什么这条重要：模式标记在浏览器 `localStorage`，**宿主插件看不见**；靠这个文件打通。
 * 读不到 / 坏文件必须**保守返回 undefined**（按非本地模式处理，保持原来的快重试），
 * 不能因为文件缺失就让通道永久不连。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isLocalModeChosen, readHostMode, writeHostMode } from './login-mode.ts'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fom-mode-'))
  dirs.push(dir)
  return join(dir, 'nested', 'login-mode.json')
}

describe('宿主侧模式标记', () => {
  it('写入 local ⇒ 读到 local，且 isLocalModeChosen 为真', async () => {
    const path = await tempPath()
    writeHostMode('local', path)
    expect(readHostMode(path)).toBe('local')
    expect(isLocalModeChosen(path)).toBe(true)
  })

  it('写入 signed / gate ⇒ isLocalModeChosen 为假（只有 local 才降频）', async () => {
    const path = await tempPath()
    writeHostMode('signed', path)
    expect(readHostMode(path)).toBe('signed')
    expect(isLocalModeChosen(path)).toBe(false)

    writeHostMode('gate', path)
    expect(readHostMode(path)).toBe('gate')
    expect(isLocalModeChosen(path)).toBe(false)
  })

  it('文件不存在 ⇒ undefined，且 isLocalModeChosen 保守为假', async () => {
    const path = await tempPath()
    expect(readHostMode(path)).toBeUndefined()
    expect(isLocalModeChosen(path)).toBe(false)
  })

  it('坏文件 / 未知值 ⇒ undefined（保守，不抛）', async () => {
    const path = await tempPath()
    await writeHostMode('local', path)

    await writeFile(path, 'not json', 'utf8')
    expect(readHostMode(path)).toBeUndefined()

    await writeFile(path, JSON.stringify({ mode: 'telepathy' }), 'utf8')
    expect(readHostMode(path)).toBeUndefined()
    expect(isLocalModeChosen(path)).toBe(false)
  })

  it('目录不存在时也能写（自动建目录）', async () => {
    const path = await tempPath()
    expect(() => writeHostMode('local', path)).not.toThrow()
    expect(readHostMode(path)).toBe('local')
  })
})

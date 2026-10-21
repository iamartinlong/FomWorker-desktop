/**
 * 三态判定与持久化验收：身份优先、本地标记生效、清除后回门禁、显示名回退。
 */
import { describe, expect, it } from 'vitest'
import {
  LOCAL_MODE_VALUE,
  MODE_KEY,
  avatarInitialOf,
  clearLocalMode,
  createMemoryModeStore,
  displayNameOf,
  enterLocalMode,
  isLocalMode,
  resolveMode,
  shouldGate,
} from './mode.ts'
import { createMemoryStore } from '../../session.ts'

const USER = {
  userId: 'u-1',
  tenantId: 't-1',
  email: 'dev@fominfo.cn',
  displayName: '张三',
  role: 'owner',
}

/** 有身份的会话存储。 */
function signedStore(): ReturnType<typeof createMemoryStore> {
  const store = createMemoryStore()
  store.save({ user: USER })
  return store
}

describe('resolveMode（三态判定）', () => {
  it('全新安装（无身份、无标记）⇒ gate', () => {
    expect(resolveMode(createMemoryStore(), createMemoryModeStore())).toBe('gate')
  })

  it('有身份 ⇒ signed', () => {
    expect(resolveMode(signedStore(), createMemoryModeStore())).toBe('signed')
  })

  it('只有本地标记 ⇒ local', () => {
    const modes = createMemoryModeStore()
    enterLocalMode(modes)
    expect(resolveMode(createMemoryStore(), modes)).toBe('local')
  })

  it('身份与标记并存 ⇒ 身份优先（signed）', () => {
    const modes = createMemoryModeStore()
    enterLocalMode(modes)
    expect(resolveMode(signedStore(), modes)).toBe('signed')
  })
})

describe('本地模式标记', () => {
  it('写入后可读，且落在约定的键上', () => {
    const modes = createMemoryModeStore()
    expect(isLocalMode(modes)).toBe(false)
    enterLocalMode(modes)
    expect(isLocalMode(modes)).toBe(true)
    expect(modes.get(MODE_KEY)).toBe(LOCAL_MODE_VALUE)
  })

  it('清除后回 gate（登录成功 / 回门禁时用）', () => {
    const modes = createMemoryModeStore()
    enterLocalMode(modes)
    clearLocalMode(modes)
    expect(isLocalMode(modes)).toBe(false)
    expect(resolveMode(createMemoryStore(), modes)).toBe('gate')
  })
})

describe('派生判定', () => {
  it('只有 gate 挡门禁', () => {
    expect(shouldGate('gate')).toBe(true)
    expect(shouldGate('local')).toBe(false)
    expect(shouldGate('signed')).toBe(false)
  })
})

describe('显示名与头像首字', () => {
  it('优先 displayName，其次 email，最后兜底', () => {
    expect(displayNameOf(USER)).toBe('张三')
    expect(displayNameOf({ ...USER, displayName: '  ' })).toBe('dev@fominfo.cn')
    expect(displayNameOf({ ...USER, displayName: undefined, email: undefined })).toBe('已登录')
  })

  it('中文取首字、英文取首字母大写', () => {
    expect(avatarInitialOf(USER)).toBe('张')
    expect(avatarInitialOf({ ...USER, displayName: 'alice' })).toBe('A')
    expect(avatarInitialOf({ ...USER, displayName: undefined })).toBe('D')
  })
})

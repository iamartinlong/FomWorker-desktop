import { describe, expect, it } from 'vitest'
import {
  ROLE_PRESET,
  TENANT_ROLES,
  identityNoticeFor,
  resolveContext,
  validateTables,
  type RouterTables,
} from './directory.ts'

const tables: RouterTables = {
  bindings: {
    'ou_owner': { tenantId: 't1', role: 'owner' },
    'ou_member': { tenantId: 't1', role: 'member' },
  },
  tenants: {
    t1: { tenantId: 't1', homeDir: 'C:/tenants/t1/.dsh', workspaceRoot: 'C:/tenants/t1/ws' },
  },
}

describe('office-router · 解析（open_id → 会话章）', () => {
  it('绑定的身份得到完整会话章（含预设与身份提示）', () => {
    const stamp = resolveContext('ou_owner', tables)
    expect(stamp).toBeDefined()
    expect(stamp?.tenantId).toBe('t1')
    expect(stamp?.role).toBe('owner')
    expect(stamp?.homeDir).toBe('C:/tenants/t1/.dsh')
    expect(stamp?.workspaceRoot).toBe('C:/tenants/t1/ws')
    expect(stamp?.presetId).toBe('standard')
    expect(stamp?.identityNotice).toContain('t1')
    expect(stamp?.identityNotice).toContain('owner')
  })

  it('member 映射到办公预设', () => {
    expect(resolveContext('ou_member', tables)?.presetId).toBe('office')
  })

  it('fail-closed：未绑定的身份 → undefined', () => {
    expect(resolveContext('ou_unknown', tables)).toBeUndefined()
  })

  it('fail-closed：绑定指向缺失的租户 → undefined', () => {
    const broken: RouterTables = { bindings: { x: { tenantId: 'ghost', role: 'member' } }, tenants: {} }
    expect(resolveContext('x', broken)).toBeUndefined()
  })
})

describe('office-router · 映射与文案', () => {
  it('每个角色都有预设映射', () => {
    for (const role of TENANT_ROLES) expect(typeof ROLE_PRESET[role]).toBe('string')
  })

  it('身份提示含租户与角色，且不含凭据字样', () => {
    const notice = identityNoticeFor('acme', 'admin')
    expect(notice).toContain('acme')
    expect(notice).toContain('admin')
    expect(notice.toLowerCase()).not.toContain('secret')
    expect(notice).not.toContain('token')
  })
})

describe('office-router · 表校验', () => {
  it('自洽表通过', () => {
    expect(validateTables(tables)).toEqual([])
  })

  it('抓非法角色 / 指向缺失租户 / 空字段', () => {
    const bad: RouterTables = {
      bindings: { a: { tenantId: 't9', role: 'admin' }, b: { tenantId: 't8', role: 'superuser' as never } },
      tenants: { t9: { tenantId: 't9', homeDir: '', workspaceRoot: '' } },
    }
    const problems = validateTables(bad)
    expect(problems).toContainEqual(expect.stringContaining('角色非法'))
    expect(problems).toContainEqual(expect.stringContaining('不存在的租户'))
    expect(problems).toContainEqual(expect.stringContaining('homeDir 为空'))
    expect(problems).toContainEqual(expect.stringContaining('workspaceRoot 为空'))
  })
})

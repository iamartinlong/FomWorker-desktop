import { describe, expect, it } from 'vitest'
import {
  ACTION_POLICY,
  OFFICE_ACTIONS,
  OfficeAuthzError,
  assertCan,
  can,
  requiresApproval,
  validatePolicy,
  type OfficeAction,
} from './roles.ts'

describe('office-authz · 矩阵自检', () => {
  it('矩阵通过自检（无空角色、无未知角色、无 guest 高危）', () => {
    expect(validatePolicy()).toEqual([])
  })

  it('每个登记动作都有策略', () => {
    for (const action of OFFICE_ACTIONS) expect(ACTION_POLICY[action]).toBeDefined()
  })
})

describe('office-authz · 授权（对齐控制台写权限设计 §2 矩阵）', () => {
  it('owner/admin 可安装/卸载/改配置（高危）', () => {
    for (const role of ['owner', 'admin'] as const) {
      expect(can(role, 'bundle.install')).toBe(true)
      expect(can(role, 'bundle.remove')).toBe(true)
      expect(can(role, 'config.edit')).toBe(true)
    }
  })

  it('member 不能安装/卸载/改配置，但可查看与建技能', () => {
    expect(can('member', 'bundle.install')).toBe(false)
    expect(can('member', 'bundle.remove')).toBe(false)
    expect(can('member', 'config.edit')).toBe(false)
    expect(can('member', 'capability.toggle')).toBe(false)
    expect(can('member', 'console.view')).toBe(true)
    expect(can('member', 'skill.create')).toBe(true)
  })

  it('guest 什么写动作都不能，连查看控制台也不行', () => {
    for (const action of OFFICE_ACTIONS) expect(can('guest', action)).toBe(false)
  })

  it('只有 owner/admin 能启停已装能力', () => {
    expect(can('owner', 'capability.toggle')).toBe(true)
    expect(can('admin', 'capability.toggle')).toBe(true)
    expect(can('member', 'capability.toggle')).toBe(false)
  })
})

describe('office-authz · 审批要求', () => {
  it('安装/卸载/改配置须审批；查看/启停/建技能不须', () => {
    expect(requiresApproval('bundle.install')).toBe(true)
    expect(requiresApproval('bundle.remove')).toBe(true)
    expect(requiresApproval('config.edit')).toBe(true)
    expect(requiresApproval('console.view')).toBe(false)
    expect(requiresApproval('capability.toggle')).toBe(false)
    expect(requiresApproval('skill.create')).toBe(false)
  })
})

describe('office-authz · fail-closed', () => {
  it('未登记动作一律拒绝', () => {
    expect(can('owner', 'nope' as OfficeAction)).toBe(false)
    expect(requiresApproval('nope' as OfficeAction)).toBe(true)
    expect(() => assertCan('owner', 'nope' as OfficeAction)).toThrow(OfficeAuthzError)
  })

  it('assertCan 对禁止动作抛错且带 code', () => {
    try {
      assertCan('member', 'bundle.install')
      expect.unreachable('应当抛出')
    } catch (error) {
      expect(error).toBeInstanceOf(OfficeAuthzError)
      expect((error as OfficeAuthzError).code).toBe('office-authz/forbidden')
    }
  })

  it('assertCan 对允许动作不抛', () => {
    expect(() => assertCan('owner', 'bundle.install')).not.toThrow()
  })
})

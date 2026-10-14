/**
 * 控制台**写操作决策核心**（M2/D · 控制台写操作权限设计 §2 「三重防护」的决策那半）。
 *
 * 三重防护：① 鉴权（Remote 的活，不在此）→ **② 授权**（角色能否做）→ **③ 审批**（高危须已获一次性批准）。
 * 本模块只做 ②③ 的**纯决策**：给定 `(role, action, approved)`，判定 `forbidden / needs-approval / done`，
 * 且**只在允许且已批准时才执行** `execute()`（高危未批时绝不触碰执行体）。
 *
 * 依据：`docs/02-设计/控制台写操作权限设计v0.1.md` §2。
 */

import { can, requiresApproval, type OfficeAction, type OfficeRole } from './roles.ts'

/** 一次写操作的结果。 */
export type ConsoleActionResult<T> =
  | { readonly status: 'done'; readonly value: T }
  | { readonly status: 'needs-approval' }
  | { readonly status: 'forbidden'; readonly reason: string }

/** 写操作输入。 */
export interface ConsoleActionInput {
  readonly role: OfficeRole
  readonly action: OfficeAction
  /** 该高危动作是否已获（一次性）批准。 */
  readonly approved: boolean
}

/**
 * 执行一次控制台写操作（纯决策壳）。
 * - 角色不允许 ⇒ `forbidden`（**不执行**）；
 * - 高危且未批准 ⇒ `needs-approval`（**不执行**）；
 * - 否则 ⇒ 执行 `execute()` 并返回 `done`。
 * @param input - `(role, action, approved)`。
 * @param execute - 仅在被允许且已批准时调用的执行体。
 * @returns 决策结果。
 */
export async function runConsoleAction<T>(
  input: ConsoleActionInput,
  execute: () => T | Promise<T>,
): Promise<ConsoleActionResult<T>> {
  if (!can(input.role, input.action)) {
    return { status: 'forbidden', reason: `角色 ${input.role} 不允许动作 ${input.action}` }
  }
  if (requiresApproval(input.action) && !input.approved) {
    return { status: 'needs-approval' }
  }
  return { status: 'done', value: await execute() }
}

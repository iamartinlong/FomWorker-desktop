/**
 * R0 的**输出桥**（M2/C）：把「会话章」落成**内核会话创建**所需的输入（`meta.cwd` / 预设 / 身份提示段）。
 *
 * 这是「路由层 → 内核会话创建窗口」的接缝：入站适配器在建会话时调 `planSession(openId, tables)`，
 * 把返回的 `cwd`/`agentPreset` 交给内核 `CreateSessionOptions.meta`、把 `identityNotice` 挂成
 * `systemPrompt.section`（作用域内）。
 *
 * ⚠️ **缺口登记**：真正的**入站适配器**（IM 消息 → 建会话）**尚未实现**（`office-feishu` 目前只注册工具、
 * 不含会话创建路径）——它是本桥的**前置组件**，不在本步范围。本步只产出可测的桥与计划。
 *
 * 依据：`docs/02-设计/路由与权限模型设计v0.1.md` §4（创建窗口盖章）。
 */

import { resolveContext, type RouterTables, type SessionStamp } from './directory.ts'

/** 内核会话创建计划（交给适配器填 `meta` + 注入提示段）。 */
export interface SessionCreationPlan {
  /** → `meta.cwd`（会话级工作区根）。 */
  readonly cwd: string
  /** → `meta.agentPreset`（该角色的预设 id）。 */
  readonly agentPreset: string
  /** → 作用域内 `systemPrompt.section` 文案。 */
  readonly identityNotice: string
}

/**
 * 把会话章映射成创建计划。
 * @param stamp - 会话章。
 * @returns 创建计划。
 */
export function toSessionCreation(stamp: SessionStamp): SessionCreationPlan {
  return { cwd: stamp.workspaceRoot, agentPreset: stamp.presetId, identityNotice: stamp.identityNotice }
}

/**
 * 一步解析入站身份 → 创建计划（未绑定/租户缺失 → `undefined`，fail-closed）。
 * @param openId - 入站 `open_id`/`user_id`。
 * @param tables - 路由表。
 * @returns 创建计划；未绑定则 `undefined`。
 */
export function planSession(openId: string, tables: RouterTables): SessionCreationPlan | undefined {
  const stamp = resolveContext(openId, tables)
  return stamp === undefined ? undefined : toSessionCreation(stamp)
}

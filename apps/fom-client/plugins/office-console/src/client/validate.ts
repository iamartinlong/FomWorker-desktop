/**
 * 控制台**表单校验**（纯模块，无 React / 无 IO）。
 *
 * 口径（`前端技术栈与页面实现规范v0.1` §3.10）：**前端必填/格式校验先挡住**，不把坏输入打到后端；
 * 宿主的权威校验仍在（`office-console/executor.ts`，缺字段 → **400** 而非 500）。
 *
 * `slug`/`id` 的规则与宿主 `office-skills/managed.ts` 的 `isValidSkillSlug`、
 * `office-experts/delta.ts` 的 `isValidExpertId` **同一条**：`^[a-z0-9][a-z0-9._-]*$`。
 */

/** 新建技能的草稿。 */
export interface SkillDraft {
  slug: string
  name: string
  description: string
  body: string
}

/** 新建专家的草稿。 */
export interface ExpertDraft {
  id: string
  name: string
  description: string
  personaPrefix: string
  planMode: boolean
  subagent: boolean
}

/** 字段 → 错误消息（无错误即空对象）。 */
export type FieldErrors = Readonly<Record<string, string>>

/** slug / id 规则（与宿主同一正则）。 */
export const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u

/** 校验新建技能草稿。 */
export function validateSkillDraft(draft: SkillDraft): FieldErrors {
  const errors: Record<string, string> = {}
  if (draft.slug === '') errors.slug = '必填'
  else if (!ID_PATTERN.test(draft.slug)) errors.slug = '小写字母/数字开头，可含 . _ -'
  if (draft.name === '') errors.name = '必填'
  if (draft.body === '') errors.body = '必填'
  return errors
}

/** 校验新建专家草稿。 */
export function validateExpertDraft(draft: ExpertDraft): FieldErrors {
  const errors: Record<string, string> = {}
  if (draft.id === '') errors.id = '必填'
  else if (!ID_PATTERN.test(draft.id)) errors.id = '小写字母/数字开头，可含 . _ -'
  if (draft.name === '') errors.name = '必填'
  return errors
}

/** 是否有错误。 */
export function hasErrors(errors: FieldErrors): boolean {
  return Object.keys(errors).length > 0
}

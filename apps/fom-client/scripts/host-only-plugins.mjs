/**
 * host 半需要产物的插件清单（browser-only 的另有 tsdown 链）。
 *
 * **单一真相源**：`build-host-halves.mjs` 与 `verify/replay-host-halves.mjs` 都从这里取。
 * 别再各自抄一份——清单写两处必漂（踩坑 §2.30 第二次形态同款）。
 *
 * 加一个 host 插件时改这里，两处同时生效。
 */

export const HOST_ONLY = [
  'office-catalog',
  'office-authz',
  'office-console',
  'office-experts',
  'office-skills',
  'office-approval',
  'office-feishu',
  'office-billing',
  'office-reporter',
  'office-channel',
  'office-delegate',
  'office-tasks',
]

export default HOST_ONLY

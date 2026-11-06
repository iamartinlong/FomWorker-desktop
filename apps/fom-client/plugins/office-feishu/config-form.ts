/**
 * **飞书连接器的配置表单声明**（插件型连接器的样板：《详细实施-连接器配置表单v0.1》§4.1）。
 *
 * 放在叶子模块（不 import 任何东西）是为了让 `office-console` 能直接引它——
 * 照 `office-skills/managed.ts` / `office-experts/delta.ts` 的既有做法：**跨插件引叶子，不引插件壳**。
 *
 * ⚠️ 表单键 ≠ 配置键：`feishuAppSecret` 是**虚拟键**，它的值走宿主凭据库
 * （ref `FOM_FEISHU_APP_SECRET`，正是 `readAppSecret()` 首选的那一个），
 * 由端点的 `splitFormValues()` 分流，**不写进 config**。
 * 真正落 config 的是 `feishuAppId` / `readOnly` / `baseUrl`。
 */

import type { ConfigForm } from '../office-console/connector-form.ts'

export const configForm: ConfigForm = [
  {
    key: 'feishuAppId',
    label: 'App ID',
    type: 'text',
    required: true,
    placeholder: 'cli_xxxxxxxxxxxxxxxx',
    hint: '飞书开放平台 → 应用详情 → 凭证与基础信息',
  },
  {
    key: 'feishuAppSecret',
    label: 'App Secret',
    type: 'secret',
    required: true,
    storeAs: 'FOM_FEISHU_APP_SECRET',
    hint: '同上；仅保存在本机凭据库，配置文件里只留引用名',
  },
  {
    key: 'readOnly',
    label: '只读模式',
    type: 'boolean',
    default: false,
    hint: '开启后只注册读工具（文档 / 多维表格 / 日历），写工具不注册',
  },
  {
    key: 'baseUrl',
    label: '传输基址',
    type: 'text',
    default: 'https://open.feishu.cn',
    hint: '测试或自建代理才需要改；一般保持默认',
  },
]

export default configForm

/**
 * 飞书连接器表单的验收（《详细实施-连接器配置表单v0.1》T2）。
 *
 * 最重要的一条是**表单键与 `OfficeFeishuConfig` 不漂**：表单是给人填的，
 * config 是插件真读的，两边对不上就是「填了没生效」。这条断言把当前的对应关系钉住；
 * **往 `OfficeFeishuConfig` 加键时，同步改这里**（要么进表单，要么明确写进「故意不进表单」的清单）。
 */

import { describe, expect, it } from 'vitest'
import { configForm } from './config-form.ts'
import { missingRequired, secretRefsOf, splitFormValues } from '../office-console/connector-form.ts'

describe('office-feishu · 配置表单', () => {
  it('四个键、无重复；对应 index.ts 的 OfficeFeishuConfig', () => {
    const keys = configForm.map((f) => f.key)
    expect(keys).toEqual(['feishuAppId', 'feishuAppSecret', 'readOnly', 'baseUrl'])
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('App ID 与 App Secret 必填；App Secret 走凭据库（storeAs 与 readAppSecret 首选 ref 同一个）', () => {
    const appId = configForm.find((f) => f.key === 'feishuAppId')
    const secret = configForm.find((f) => f.key === 'feishuAppSecret')
    expect(appId?.required).toBe(true)
    expect(appId?.type).toBe('text')
    expect(secret?.required).toBe(true)
    expect(secret?.type).toBe('secret')
    // index.ts 的 Config 里 feishuAppSecretRef 缺省就是这个值 ⇒ 表单写进凭据库后无需再改 config
    expect(secret?.storeAs).toBe('FOM_FEISHU_APP_SECRET')
    expect(secretRefsOf(configForm)).toEqual([{ key: 'feishuAppSecret', ref: 'FOM_FEISHU_APP_SECRET' }])
  })

  it('填一套真值 ⇒ 只有 App ID / 只读 / 基址进 config，Secret 单独走凭据库', () => {
    const { config, secrets } = splitFormValues(configForm, {
      feishuAppId: 'cli_a1b2', feishuAppSecret: 'topsecret', readOnly: true, baseUrl: '',
    })
    expect(config).toEqual({ feishuAppId: 'cli_a1b2', readOnly: true })
    expect(secrets).toEqual([{ ref: 'FOM_FEISHU_APP_SECRET', value: 'topsecret' }])
  })

  it('两个必填都没填时，点名的是中文 label', () => {
    expect(missingRequired(configForm, {})).toEqual(['App ID', 'App Secret'])
  })
})

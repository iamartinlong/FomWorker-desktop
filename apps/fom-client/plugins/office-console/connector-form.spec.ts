import { describe, expect, it } from 'vitest'
import {
  defaultsOf,
  missingRequired,
  secretRefsOf,
  splitFormValues,
  type ConfigForm,
} from './connector-form.ts'

const form: ConfigForm = [
  { key: 'appId', label: 'App ID', type: 'text', required: true, placeholder: 'cli_x' },
  { key: 'secret', label: 'App Secret', type: 'secret', required: true, storeAs: 'FOM_X_SECRET' },
  { key: 'readOnly', label: '只读模式', type: 'boolean', default: false },
  { key: 'baseUrl', label: '基址', type: 'text', default: 'https://open.feishu.cn' },
]

describe('connector-form · 缺省值与必填校验', () => {
  it('defaultsOf 只取声明了 default 的字段', () => {
    expect(defaultsOf(form)).toEqual({ readOnly: false, baseUrl: 'https://open.feishu.cn' })
    expect(defaultsOf([])).toEqual({})
  })

  it('missingRequired：空串 / 空白串 / 缺失都算没填（保序，只点必填的）', () => {
    expect(missingRequired(form, {})).toEqual(['App ID', 'App Secret'])
    expect(missingRequired(form, { appId: '  ', secret: 's' })).toEqual(['App ID'])
    expect(missingRequired(form, { appId: 'a', secret: 's' })).toEqual([])
    // 布尔字段即使必填也不该被这关拦（false 是合法值）
    expect(missingRequired([{ key: 'b', label: 'B', type: 'boolean', required: true }], {})).toEqual([])
  })
})

describe('connector-form · secret 分流（splitFormValues）', () => {
  it('secret 进 secrets（带 ref），其余进 config；布尔一律成布尔', () => {
    const { config, secrets } = splitFormValues(form, {
      appId: 'cli_abc', secret: 's3cr3t', readOnly: true, baseUrl: 'https://x.cn',
    })
    expect(config).toEqual({ appId: 'cli_abc', readOnly: true, baseUrl: 'https://x.cn' })
    expect(secrets).toEqual([{ ref: 'FOM_X_SECRET', value: 's3cr3t' }])
  })

  it('空 secret 不写凭据库（别用空值把库里原有的擦了）', () => {
    const { secrets } = splitFormValues(form, { appId: 'a', secret: '   ' })
    expect(secrets).toEqual([])
  })

  it('空的可选文本不写 config（让插件的 zod 缺省值说话）', () => {
    const { config } = splitFormValues(form, { appId: 'a', secret: 's', baseUrl: '' })
    expect('baseUrl' in config).toBe(false)
  })

  it('必填文本即使为空也写进去（让下游的必填校验去报，而不是静默丢键）', () => {
    // 布尔一律落 config——否则「取消勾选」永远存不下去
    const { config } = splitFormValues(form, { appId: '', secret: '' })
    expect(config).toEqual({ appId: '', readOnly: false })
  })

  it('secretRefsOf 只收声明了 storeAs 的', () => {
    expect(secretRefsOf(form)).toEqual([{ key: 'secret', ref: 'FOM_X_SECRET' }])
    expect(secretRefsOf([{ key: 'a', label: 'A', type: 'text' }])).toEqual([])
  })

  // 反向回归：把 secret 的 storeAs 忘掉 ⇒ 值会直接落进 config（明文进配置文件）
  it('反向：没有 storeAs 的 secret 字段会落进 config——这正是要防的', () => {
    const noStore: ConfigForm = [{ key: 'secret', label: 'S', type: 'secret', required: true }]
    const { config, secrets } = splitFormValues(noStore, { secret: 'v' })
    expect(secrets).toEqual([])
    expect(config).toEqual({ secret: 'v' })
  })
})

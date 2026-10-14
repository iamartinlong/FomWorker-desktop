import { describe, expect, it } from 'vitest'
import { buildWebArgs, buildWebEnv, findWebUrl, isReadyStatus, parseWebUrl, planLaunches } from './supervise.ts'

describe('office-ops · 启动 argv（O1 旗标顺序）', () => {
  it('--patch 排在 --no-open/--port 之前', () => {
    const args = buildWebArgs({ homeDir: 'H', port: 3080, patches: ['/a.yml', '/b.yml'] })
    expect(args).toEqual([
      '--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web',
      '--patch', '/a.yml', '--patch', '/b.yml', '--no-open', '--port', '3080',
    ])
    expect(args.indexOf('--patch')).toBeLessThan(args.indexOf('--no-open'))
    expect(args.indexOf('--patch')).toBeLessThan(args.indexOf('--port'))
  })

  it('可关 --no-open 与自定义入口/node 旗标', () => {
    const args = buildWebArgs({ homeDir: 'H', port: 1, noOpen: false, nodeArgs: [], appEntry: 'x.ts' })
    expect(args).toEqual(['x.ts', 'web', '--port', '1'])
  })
})

describe('office-ops · 环境注入（O3 DSH_HOME）', () => {
  it('注入 DSH_HOME 且不污染基线', () => {
    const base = { PATH: 'x' } as NodeJS.ProcessEnv
    const env = buildWebEnv({ homeDir: 'C:/t/.dsh', port: 1 }, base)
    expect(env.DSH_HOME).toBe('C:/t/.dsh')
    expect(env.PATH).toBe('x')
    expect(base.DSH_HOME).toBeUndefined()
  })
})

describe('office-ops · 就绪与地址（O8）', () => {
  it('isReadyStatus：401/200 就绪，404/502 未就绪', () => {
    expect(isReadyStatus(401)).toBe(true)
    expect(isReadyStatus(200)).toBe(true)
    expect(isReadyStatus(404)).toBe(false)
    expect(isReadyStatus(502)).toBe(false)
  })

  it('parseWebUrl 取地址并去尾标点', () => {
    expect(parseWebUrl('dsh web: http://127.0.0.1:3095/?token=abc.')).toBe('http://127.0.0.1:3095/?token=abc')
    expect(parseWebUrl('无关行')).toBeUndefined()
  })

  it('findWebUrl 取最后一条（重启取新地址）', () => {
    const log = ['noise', 'dsh web: http://127.0.0.1:1/?token=old', 'dsh web: http://127.0.0.1:2/?token=new'].join('\n')
    expect(findWebUrl(log)).toBe('http://127.0.0.1:2/?token=new')
  })
})

describe('office-ops · 编排计划（O-P1）', () => {
  it('每租户独立 home、端口顺延', () => {
    const plans = planLaunches(
      [{ tenantId: 't1', homeDir: 'C:/t1' }, { tenantId: 't2', homeDir: 'C:/t2' }],
      { basePort: 4000, patches: ['/p.yml'] },
    )
    expect(plans).toHaveLength(2)
    expect(plans[0].spec.homeDir).toBe('C:/t1')
    expect(plans[1].spec.homeDir).toBe('C:/t2')
    expect(plans[0].spec.port).toBe(4000)
    expect(plans[1].spec.port).toBe(4001)
    expect(plans[0].spec.patches).toEqual(['/p.yml'])
  })
})

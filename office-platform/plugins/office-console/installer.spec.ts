import { describe, expect, it, vi } from 'vitest'
import { createPluginManagerInstaller, type PluginManagerLike } from './installer.ts'

describe('office-console · pluginManager 安装口', () => {
  it('委托 install/remove 到 pluginManager', async () => {
    const pm: PluginManagerLike = {
      installBundle: vi.fn(async (spec: string) => ({ installed: spec })),
      removeBundle: vi.fn(async (spec: string) => ({ removed: spec })),
    }
    const installer = createPluginManagerInstaller(pm)
    expect(await installer.install('@x/y')).toEqual({ installed: '@x/y' })
    expect(await installer.remove('@x/y')).toEqual({ removed: '@x/y' })
    expect(pm.installBundle).toHaveBeenCalledWith('@x/y')
    expect(pm.removeBundle).toHaveBeenCalledWith('@x/y')
  })
})

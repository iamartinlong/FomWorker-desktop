import type { TsdownPlugin } from 'tsdown'

/** 建 out-of-tree CSS Modules 插件（`*.module.css` → 幂等 style 注入 + 类名映射）。 */
export function cssModulesPlugin(id: string): TsdownPlugin

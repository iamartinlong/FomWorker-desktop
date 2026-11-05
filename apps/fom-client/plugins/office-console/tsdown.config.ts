import { defineConfig } from 'tsdown'
import { cssModulesPlugin } from '../../build/css-modules.mjs'

/**
 * office-console 浏览器半部构建（out-of-tree，不依赖内核 packages/* 布局）。
 * 产出 CJS 闭包工厂 `window.__ModuleLoader__.load({ id, factory })`，externals 走 loader 模块表（react）。
 * 宿主半部 `index.ts` 仍由 Loader 经 tsx 源码加载（本配置不产出它）。
 */
export default defineConfig({
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  clean: false,
  sourcemap: false,
  external: [/^react($|\/)/, '@deepseek-ai/dsh-client-ui-primitives'],
  plugins: [cssModulesPlugin('@office/console')],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "@office/console", factory: (require) => {',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
})

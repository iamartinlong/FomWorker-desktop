import { defineConfig } from 'tsdown'
import { cssModulesPlugin } from '../../build/css-modules.mjs'

/**
 * office-billing 双半构建：node half（配额服务）+ browser half（设置页「用量与配额」）。
 * browser half：CJS 闭包工厂（window.__ModuleLoader__.load），externals 走 loader 模块表（react）。
 */
export default defineConfig([
  {
    entry: { index: 'index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    dts: false,
    clean: false,
    sourcemap: false,
    external: [/^react($|\/)/, '@deepseek-ai/dsh-client-ui-primitives'],
    plugins: [cssModulesPlugin('@office/billing')],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "@office/billing", factory: (require) => {',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])

import { defineConfig } from 'tsdown'

/**
 * out-of-tree 客户端插件构建（不依赖内核 packages/* 布局）。
 * node half：ESM，供 Loader 加载（空座）。
 * browser half：CJS 闭包工厂（window.__ModuleLoader__.load），externals 走 loader 模块表（react）。
 */
export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  },
  {
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2024',
    dts: false,
    clean: false,
    sourcemap: false,
    external: [/^react($|\/)/],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "@fominfo/dsh-client-ui-brand-fomworker", factory: (require) => {',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
      footer: 'return module.exports; } });',
    },
  },
])

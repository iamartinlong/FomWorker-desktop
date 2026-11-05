/**
 * out-of-tree 客户端的 CSS Modules 管线（rolldown 插件）。
 *
 * 复刻内核 `packages/client/tsdown.client.ts` 的 `dsh-css-modules-inline` 机制：
 * `x.module.css` → 虚拟模块 → 用 lightningcss 编译（类名哈希）→ 产出**幂等 style 注入代码**
 * + 默认导出类名映射。这样插件**不需要 @tsdown/css**，消费方也**不需要 CSS 管线**。
 *
 * 为什么自写：内核 `clientBundle` 预设只认核内 `packages/<group>/<pkg>` 布局，out-of-tree 用不了；
 * 见 `docs/02-设计/前端技术栈与页面实现规范v0.1.md` §3.5/§3.7（Q1）。
 */

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { transform } from 'lightningcss'

// 虚拟 id 后缀不能以 `.css` 结尾，否则会被 tsdown 自带的 CSS 管线拦截（内核同款处理）。
const CSS_VIRTUAL_PREFIX = '\0fom-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/**
 * 产出「幂等注入 + 类名映射」的模块源码。
 * @param {string} id - 插件包名（写进 style 标签，便于排查）。
 * @param {string} fileId - 物理样式表绝对路径。
 * @param {string} css - 编译后的 CSS 文本。
 * @param {Record<string, string> | undefined} classMap - 本地类名 → 哈希类名。
 * @returns {string} 模块源码。
 */
function styleInjectionModule(id, fileId, css, classMap) {
  const tagId = `${id}/${fileId}`
  const source = [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(tagId)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-fom-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.fomPlugin = ${JSON.stringify(id)};`,
    '  tag.dataset.fomCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
    classMap === undefined ? 'export {};' : `export default ${JSON.stringify(classMap)};`,
  ]
  return source.join('\n')
}

/**
 * 建 CSS Modules 插件。
 * @param {string} id - 插件包名（style 标签归属）。
 * @returns {import('tsdown').TsdownPlugin} rolldown 插件。
 */
export function cssModulesPlugin(id) {
  return {
    name: 'fom-css-modules-inline',
    resolveId(source, importer) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined && importer !== '' ? resolve(dirname(importer), source) : source
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      // 虚拟 id 会遮蔽物理文件，手动登记进 watch 图。
      this.addWatchFile(fileId)
      const source = await readFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      /** @type {Record<string, string>} */
      const classMap = {}
      const entries = Object.entries(cssExports ?? {}).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      for (const [local, exp] of entries) classMap[local] = exp.name
      return styleInjectionModule(id, fileId, code.toString(), classMap)
    },
  }
}

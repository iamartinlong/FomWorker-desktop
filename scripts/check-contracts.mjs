// 契约基本校验（零依赖）：JSON schema 可解析 + YAML 关键结构存在。
// 用法：node scripts/check-contracts.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let failed = false
const fail = (msg) => {
  console.error('✗ ' + msg)
  failed = true
}

// 1) WS schema（JSON）
try {
  const schema = JSON.parse(readFileSync(join(root, 'packages/fom-contracts/ws/client-platform.schema.json'), 'utf8'))
  if (schema.$defs === undefined) fail('ws schema 缺 $defs')
  if (!Array.isArray(schema.oneOf)) fail('ws schema 缺 oneOf')
} catch (error) {
  fail('ws schema 解析失败：' + error.message)
}

// 2) OpenAPI（YAML，零依赖：只查关键行）
for (const file of ['packages/fom-contracts/openapi/platform.yaml', 'packages/fom-contracts/openapi/gateway.yaml']) {
  try {
    const text = readFileSync(join(root, file), 'utf8')
    if (!/^openapi:\s*3\.\d/.test(text)) fail(`${file}: 缺 openapi 3.x 版本行`)
    if (!/^paths:/m.test(text)) fail(`${file}: 缺 paths:`)
    if (!/^components:/m.test(text)) fail(`${file}: 缺 components:`)
  } catch (error) {
    fail(`${file}: 读取失败：${error.message}`)
  }
}

if (failed) {
  console.error('契约校验失败')
  process.exit(1)
}
console.log('✓ 契约校验通过')

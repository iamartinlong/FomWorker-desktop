/**
 * Welcome 首屏与产品登录的衔接覆盖层（设计稿 D-1~D-4 + R-1）。
 *
 * ## 为什么需要它
 *
 * 内核的 welcome 是「配置**官方模型凭据**」的流程（`deepseek-account` + `llm-deepseek`），
 * 而 FomWorker 的产品身份在 `office-login` 的门禁里（平台账号 → `FOM_PLATFORM_TOKEN`）。
 * 两者不冲突，但要衔接：**首次启动先看到 FomWorker 品牌页，再进产品门禁**，且首次体验
 * 只发生一次。
 *
 * ## 三条互相独立的判据（缺一就会出现「退出登录后又弹 welcome」这类问题）
 *
 * 1. `platformLoggedIn`：宿主凭据库里有 `FOM_PLATFORM_TOKEN`。这是**两个窗口唯一共享的事实**
 *    （welcome 与主窗口是不同 origin，`localStorage` 不互通）。
 * 2. `welcomeCompleted`：本安装实例已经走过首次体验。落 **Electron `userData`**，不落
 *    `$DSH_HOME`——它描述「这个安装的首次体验」，不是跟着人走的数据（R-1 已定）。
 * 3. 原有的官方账号 / API Key 判据**保留不删**（R-2）：老用户与 BYO Key 用户不受影响。
 *
 * ## 首屏只做「品牌 + 交接」（2026-10-20 拍板）
 *
 * 门禁**自己**就有「先本地使用」，若欢迎页再放一个会让用户连点两次同一个意思的按钮，而两个
 * 窗口的 `localStorage` 不互通、主进程写不进渲染器状态。所以欢迎页只留两个**同样语义**的
 * 交接按钮：都进主窗口，由 `office-login` 的门禁统一收口身份与本地模式。
 *
 * **连带删除**（否则就是死代码）：官方授权页、API Key 页、超时重试、复制登录链接、以及
 * 只为它们存在的 `account-backend` 的写侧与 `WELCOME_IPC` 通道。`account-backend` 本身
 * 保留——官方授权流仍要能用（R-2：失败/超时回到主窗口、等待时打开浏览器）。
 *
 * ## 为什么用 overlay 改内核文件
 *
 * `deepseek-harness/` 是独立仓库且被 `.gitignore` 排除，产品仓**只保留可复现的补丁脚本**
 * （与 `apply-data-isolation.mjs` 同一套做法）。这样升级内核时补丁可重放、可 review，
 * 也不会把内核改动混进产品提交。
 *
 * ## 幂等
 *
 * 每个补丁点各自判断「是否已应用」；全部应用后只打印状态。源码有补丁 ≠ 产物是新的，
 * 重建由 `apply-welcome-entry-build.mjs` 负责（与数据隔离同一个阶段约束）。
 *
 * 用法（桌面仓根）：node branding/apply-welcome-entry.mjs [内核目录=deepseek-harness]
 */
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const kernelRoot = resolve(process.argv[2] ?? 'deepseek-harness')
const srcDir = join(kernelRoot, 'apps', 'desktop', 'src')

let applied = 0
let skipped = 0

/**
 * Replace exactly one anchor occurrence, asserting both presence and idempotence.
 * @param file - absolute target path.
 * @param detect - substring proving the patch is already applied.
 * @param anchor - exact source text to replace.
 * @param replacement - patched source text.
 * @param label - diagnostic name.
 */
async function patch(file, detect, anchor, replacement, label) {
  const source = await readFile(file, 'utf8')
  if (source.includes(detect)) {
    skipped += 1
    return
  }
  if (!source.includes(anchor)) throw new Error(`welcome entry: ${label} anchor not found in ${file}`)
  await writeFile(file, source.replace(anchor, replacement))
  applied += 1
}

/**
 * Write a whole file, skipping when it already has the intended content.
 * @param file - absolute target path.
 * @param detect - substring proving the file is already the intended version.
 * @param content - complete intended source.
 * @param label - diagnostic name.
 */
async function rewrite(file, detect, content, label) {
  if (existsSync(file)) {
    const source = await readFile(file, 'utf8')
    if (source.includes(detect)) {
      skipped += 1
      return
    }
  }
  await writeFile(file, content)
  applied += 1
  void label
}

// ── 1. 首次体验标记模块（新文件）─────────────────────────────────────
const markerPath = join(srcDir, 'welcome-marker.ts')
await rewrite(markerPath, 'export function markWelcomeCompleted', `/**
 * First-run marker for the native welcome entry.
 *
 * \`welcomeCompleted\` answers "has this **installation** already shown the first-run
 * entry?", which is not the same question as "is the user signed in". Keeping it in
 * \`userData\` matches that meaning: a reinstall or a different machine has genuinely
 * not had the first-run experience yet, while the Harness home holds data that
 * follows the person (sessions, credentials, workspaces).
 *
 * The file is a zero-byte marker, the same form as \`background-close-confirmed\`
 * in \`main.ts\`; existence is the whole state, so a torn write cannot corrupt it.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Marker filename under the Electron \`userData\` directory. */
export const WELCOME_MARKER_NAME = 'welcome-completed'

/**
 * Whether this installation has already passed the first-run entry.
 * @param markerPath - absolute marker path under \`userData\`.
 * @returns true when the marker exists.
 */
export function welcomeCompleted(markerPath: string): boolean {
  return existsSync(markerPath)
}

/**
 * Record that this installation has passed the first-run entry.
 *
 * Best effort by design: the marker only suppresses a future entry, so a write
 * failure must never block the user from reaching the workspace.
 * @param markerPath - absolute marker path under \`userData\`.
 */
export function markWelcomeCompleted(markerPath: string): void {
  try {
    mkdirSync(dirname(markerPath), { recursive: true })
    writeFileSync(markerPath, '')
  } catch {
    /* The user still enters the workspace; only the next launch shows the entry again. */
  }
}
`, 'marker module')

// ── 2. welcome-api.ts：判据 + 收窄到单一交接动作 ──────────────────────
await rewrite(join(srcDir, 'welcome-api.ts'), 'enterWorkspace: \'dsh-welcome:enter-workspace\'', `/** Operations available to the isolated native welcome renderer. */

import type { DesktopLocale } from './locale.ts'

/** Private native welcome channels, installed only while its window exists. */
export const WELCOME_IPC = {
  enterWorkspace: 'dsh-welcome:enter-workspace',
} as const

/** Host-owned operations used by the welcome window. */
export interface WelcomeOperations {
  /**
   * Leave the first-run entry and show the main window.
   *
   * The product gate in the main window owns identity and the local-mode choice, so
   * the entry has exactly one hand-off and no credential operations of its own.
   */
  enterWorkspace(): Promise<void>
}

/** The renderer receives localized copy and the single hand-off action. */
export type WelcomeApi = DesktopLocale & WelcomeOperations

/** Authentication facts supplied at cold start or after a completed sign-out. */
export interface WelcomeAuthentication {
  readonly loggedIn: boolean
  readonly hasApiKey: boolean
  /** Whether the product platform token is already in the Host credential store. */
  readonly platformLoggedIn: boolean
  /** Whether this installation has already finished the first-run entry. */
  readonly welcomeCompleted: boolean
}

/**
 * Decide whether a startup or sign-out requires the welcome entry.
 *
 * The entry is a **first-run** experience, not an unauthenticated state: once this
 * installation has passed it (\`welcomeCompleted\`) it never returns, even after the
 * user signs out. A completed product sign-in also satisfies it, because the
 * platform token is the one fact both windows share.
 * @param authentication - product token, official account, API-key, and first-run facts.
 * @returns true only before this installation has entered the workspace by any route.
 */
export function needsWelcome(authentication: WelcomeAuthentication): boolean {
  if (authentication.welcomeCompleted) return false
  return !authentication.platformLoggedIn
    && !authentication.loggedIn
    && !authentication.hasApiKey
}
`, 'welcome-api')

// ── 3. welcome-backend.ts：加 platformLoggedIn，去掉写侧 ──────────────
await rewrite(join(srcDir, 'welcome-backend.ts'), 'readonly platformLoggedIn: boolean', `import type { ProductEvent } from '@deepseek-ai/dsh-client-product-analytics/types'
/** Native first-run reads using the shared Web authentication and RPC APIs. */

import { randomUUID } from 'node:crypto'
import { desktopAccountBackend, type DesktopAccountBackend } from './account-backend.ts'

/** Facts the entry needs before the workspace becomes visible. */
export interface WelcomeState {
  /** Whether the product platform token already exists in the Host credential store. */
  readonly platformLoggedIn: boolean
  /** Whether any provider API key is configured; still suppresses the entry (R-2). */
  readonly hasApiKey: boolean
  /** Whether a DeepSeek official account credential is stored; still suppresses the entry (R-2). */
  readonly loggedIn: boolean
  readonly localePreference: string | null
}

/**
 * Credential reference holding the product platform token.
 *
 * \`office-login\` owns the write side; the native entry only reads whether it is
 * present, because that is the one fact the two independent window origins share.
 */
export const PLATFORM_TOKEN_REF = 'FOM_PLATFORM_TOKEN'

/** Narrow read-only operations available to the native first-run entry. */
export interface DesktopWelcomeBackend {
  /** @returns the current Host policy; every read observes live configuration. */
  analyticsEnabled(): Promise<boolean>
  /**
   * Official DeepSeek account operations.
   *
   * Retained for R-2: the entry no longer offers this flow, but an existing official
   * session must keep working (browser authorization, focus return, completion).
   */
  readonly account: DesktopAccountBackend
  /** @param event - desktop-owned fields. @returns after local Host intake. */
  report(event: ProductEvent): Promise<void>
  /** @returns first-run facts and the shared language preference, without credential values. */
  read(): Promise<WelcomeState>
  /** @returns The saved UI language without account or provider requests. */
  readLocalePreference(): Promise<string | null>
  /**
   * Store the official provider's key.
   *
   * The entry no longer offers this write (the product gate owns identity), but the
   * capability stays: R-2 keeps the official credential flow working, and the
   * end-to-end test exercises it against a real Host composition.
   * @param apiKey - User-entered official provider key.
   * @returns A safe write outcome without provider diagnostics.
   */
  save(apiKey: string): Promise<{ ok: boolean }>
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Authenticate the native HTTP client through the Web application's launch URL.
 * @param authenticatedUrl - URL supplied by the running Desktop Host.
 * @param send - Electron session fetch, retaining the Web authentication cookie.
 * @param cookies - Current cookie header for account requests.
 * @returns metadata reads over standard RPC.
 */
export async function connectDesktopWelcome(
  authenticatedUrl: string,
  send: (input: string, init?: RequestInit) => Promise<Response>,
  cookies: () => Promise<string> = () => Promise.resolve(''),
): Promise<DesktopWelcomeBackend> {
  const origin = new URL(authenticatedUrl).origin
  const authenticated = await send(authenticatedUrl, { credentials: 'include' })
  await authenticated.body?.cancel()
  if (!authenticated.ok) throw new Error('desktop welcome: Web authentication failed')
  const invoke = async (
    request: { namespace: string; method: string; args: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const rpcId = randomUUID()
    const method = \`\${request.namespace}/\${request.method}\`
    const response = await send(new URL(\`/api/\${method}\`, origin).href, {
      method: 'POST', credentials: 'include', redirect: 'error', ...(signal === undefined ? {} : { signal }),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args: request.args } }),
    })
    if (!response.ok) throw new Error('desktop welcome: Web request failed')
    const envelope: unknown = await response.json()
    if (!record(envelope) || envelope.type !== 'server-response' || envelope.rpcId !== rpcId
      || !record(envelope.result) || envelope.result.ok !== true) {
      throw new Error('desktop welcome: Web RPC failed')
    }
    return envelope.result.value
  }
  const providerReferences = async (namespaces: unknown[]): Promise<string[]> => {
    const providers = await invoke({ namespace: 'llm', method: 'listConfigurableProviders', args: {} })
    if (!Array.isArray(providers)) throw new Error('desktop welcome: invalid provider directory')
    return providers.flatMap((provider: unknown) => {
      if (!record(provider) || typeof provider.settingsNs !== 'string' || !Array.isArray(provider.settingsPath)) {
        throw new Error('desktop welcome: invalid provider settings address')
      }
      const namespace: unknown = namespaces.find((item: unknown) => record(item) && item.ns === provider.settingsNs)
      let value: unknown = record(namespace) ? namespace.value : undefined
      for (const key of provider.settingsPath as unknown[]) {
        if (typeof key !== 'string') throw new Error('desktop welcome: invalid provider settings path')
        value = record(value) ? value[key] : undefined
      }
      return record(value) && typeof value.apiKeyEnv === 'string' ? [value.apiKeyEnv] : []
    })
  }
  const localePreference = (namespaces: unknown[]): string | null => {
    const locale: unknown = namespaces.find((item: unknown) => record(item) && item.ns === 'locale')
    if (!record(locale) || !record(locale.value)
      || (locale.value.preference !== undefined && typeof locale.value.preference !== 'string')) {
      throw new Error('desktop welcome: invalid locale preference')
    }
    return locale.value.preference ?? null
  }
  return {
    account: desktopAccountBackend(origin, invoke, cookies),
    read: async () => {
      const settings = await invoke({ namespace: 'settings', method: 'describe', args: {} })
      if (!record(settings) || !Array.isArray(settings.namespaces)) throw new Error('desktop welcome: missing settings namespaces')
      const unique = [...new Set([...await providerReferences(settings.namespaces), PLATFORM_TOKEN_REF])]
      const states: Record<string, unknown> = {}
      // credentials.describe accepts at most 64 references per request.
      for (let offset = 0; offset < unique.length; offset += 64) {
        const batch = await invoke({ namespace: 'credentials', method: 'describe', args: { refs: unique.slice(offset, offset + 64) } })
        if (!record(batch)) throw new Error('desktop welcome: invalid credential metadata')
        Object.assign(states, batch)
      }
      // The official account and provider keys remain suppression facts (R-2):老用户与 BYO Key
      // 用户不该因为本次改造重新看到首次体验页。
      const account = await desktopAccountBackend(origin, invoke, cookies).state()
      const hasApiKey = Object.entries(states)
        .some(([name, value]) => name !== PLATFORM_TOKEN_REF && record(value) && value.configured === true)
      return {
        platformLoggedIn: record(states[PLATFORM_TOKEN_REF]) && states[PLATFORM_TOKEN_REF].configured === true,
        hasApiKey,
        loggedIn: account.status === 'credential-stored',
        localePreference: localePreference(settings.namespaces),
      }
    },
    async analyticsEnabled() {
      const enabled = await invoke({ namespace: 'productAnalytics', method: 'enabled', args: {} }, AbortSignal.timeout(1000))
      if (typeof enabled !== 'boolean') throw new Error('desktop analytics: invalid collection policy')
      return enabled
    },
    async report(event) { await invoke({ namespace: 'productAnalytics', method: 'report', args: { event } }, AbortSignal.timeout(1000)) },
    async readLocalePreference() {
      const settings = await invoke({ namespace: 'settings', method: 'describe', args: {} })
      if (!record(settings) || !Array.isArray(settings.namespaces)) throw new Error('desktop welcome: missing settings namespaces')
      return localePreference(settings.namespaces)
    },
    async save(apiKey) {
      if (!/^[\\x21-\\x7e]+$/.test(apiKey)) return { ok: false }
      try {
        const settings = await invoke({ namespace: 'settings', method: 'describe', args: {} })
        if (!record(settings) || !Array.isArray(settings.namespaces)) return { ok: false }
        const official: unknown = settings.namespaces.find((item: unknown) => record(item) && item.ns === 'llm-deepseek')
        if (!record(official) || !record(official.value) || typeof official.value.apiKeyEnv !== 'string') return { ok: false }
        await invoke({ namespace: 'credentials', method: 'set', args: { ref: official.value.apiKeyEnv, value: apiKey } })
        return { ok: true }
      } catch {
        // Provider diagnostics may contain credentials; the caller owns failure copy.
        return { ok: false }
      }
    },
  }
}
`, 'welcome-backend')

// ── 4. preload-welcome.ts：只暴露交接动作 ────────────────────────────
await rewrite(join(srcDir, 'preload-welcome.ts'), 'enterWorkspace: () =>', `/** Localized welcome copy and the single hand-off action. */

import { contextBridge, ipcRenderer } from 'electron'
import { resolveDesktopLocale } from './locale.ts'
import { WELCOME_IPC, type WelcomeApi } from './welcome-api.ts'

const prefix = '--dsh-welcome-locale='
const locale = process.argv.find(argument => argument.startsWith(prefix))?.slice(prefix.length)
if (locale === undefined) throw new Error('desktop welcome: missing window locale')
const api: WelcomeApi = {
  ...resolveDesktopLocale(locale),
  enterWorkspace: () => ipcRenderer.invoke(WELCOME_IPC.enterWorkspace) as Promise<void>,
}
contextBridge.exposeInMainWorld('dshWelcome', api)
`, 'preload-welcome')

// ── 5. WelcomePage.tsx：品牌页 + 两个交接按钮 ────────────────────────
await rewrite(join(srcDir, 'client', 'WelcomePage.tsx'), 'id="use-local"', `/**
 * Desktop first-run presentation: a brand page that hands off to the workspace.
 *
 * The product gate (\`office-login\`'s \`shell.overlay\`) owns identity and the local-mode
 * choice, so this window asks nothing about credentials: both actions enter the
 * workspace and the gate decides what the user sees next.
 */
import { useEffect } from 'react'
import type { WelcomeApi } from '../welcome-api.ts'

/**
 * Render the standalone first-run entry using shell-owned copy.
 * @param props.api - isolated preload API; it exposes no credential operations.
 * @returns the brand page with its two hand-off actions.
 */
export function Welcome({ api }: { api: WelcomeApi }) {
  const { messages: m } = api

  useEffect(() => {
    document.documentElement.lang = api.id
    document.title = m.welcomeTitle
  }, [api, m.welcomeTitle])

  return <>
    <div className="titlebar" aria-hidden="true" />
    <main className="welcome" aria-labelledby="welcome-heading">
      <img className="brand" src="assets/welcome-brand.svg" alt={m.welcomeBrand} width="472" height="40" />
      <div id="tagline" className="tagline">
        <h1 id="welcome-heading"><span>{m.welcomeTaglineBefore}</span><em>{m.welcomeTaglineBrand}</em><span>{m.welcomeTaglineAfter}</span></h1>
        <p id="welcome-description">{m.welcomeDescription}</p>
      </div>
      <div id="entry-actions" className="actions">
        {/*
          Both actions only hand off: the sign-in that matters happens in the main
          window against the product platform, never against the official account.
        */}
        <button id="sign-in" className="primary" type="button" onClick={() => { void api.enterWorkspace() }}>{m.welcomeSignIn}</button>
        <button id="use-local" className="secondary" type="button" onClick={() => { void api.enterWorkspace() }}>{m.welcomeUseLocal}</button>
      </div>
    </main>
  </>
}
`, 'WelcomePage')

// ── 6. welcome-window.ts：单个 IPC 通道 ─────────────────────────────
await patch(join(srcDir, 'welcome-window.ts'), 'WELCOME_IPC.enterWorkspace', `import type { SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'
/** Native welcome window and its presentation-only renderer. */

import { join } from 'node:path'`, `import { join } from 'node:path'`, 'welcome-window unused import')

await patch(join(srcDir, 'welcome-window.ts'), 'WELCOME_IPC.enterWorkspace', `    for (const channel of [
      WELCOME_IPC.analyticsEnabled, WELCOME_IPC.analytics, WELCOME_IPC.takeNotice, WELCOME_IPC.saveApiKey,
      WELCOME_IPC.skip, WELCOME_IPC.start, WELCOME_IPC.cancel, WELCOME_IPC.copyLink,
    ]) {`, `    for (const channel of [WELCOME_IPC.enterWorkspace]) {`, 'welcome-window channels')

await patch(join(srcDir, 'welcome-window.ts'), 'operations.enterWorkspace()', `  ipcMain.handle(WELCOME_IPC.analyticsEnabled, (event) => {
    assertSender(event)
    return operations.analyticsEnabled()
  })
  ipcMain.handle(WELCOME_IPC.analytics, async (event, eventName: unknown, attributes: unknown) => {
    assertSender(event)
    if (typeof attributes !== 'object' || attributes === null || Array.isArray(attributes)) throw new Error('desktop welcome: invalid analytics attributes')
    if (eventName === 'auth_page_click' && 'button_name' in attributes && Object.keys(attributes).length === 1
      && (attributes.button_name === 'sign_in' || attributes.button_name === 'api-key')) {
      await operations.analytics?.(eventName, { button_name: attributes.button_name })
    } else if ((eventName === 'auth_page_view' || eventName === 'api_key_save_click') && Object.keys(attributes).length === 0) {
      await operations.analytics?.(eventName, {})
    } else throw new Error('desktop welcome: invalid analytics event')
  })
  ipcMain.handle(WELCOME_IPC.takeNotice, async (event) => { assertSender(event); return operations.takeNotice() })
  ipcMain.handle(WELCOME_IPC.saveApiKey, async (event, value: unknown) => {
    assertSender(event)
    if (typeof value !== 'string' || !/^[\\x21-\\x7e]+$/.test(value)) return { ok: false }
    return operations.saveApiKey(value)
  })
  ipcMain.handle(WELCOME_IPC.skip, async (event) => {
    assertSender(event)
    await operations.skip()
  })
  ipcMain.handle(WELCOME_IPC.start, async (event) => { assertSender(event); return operations.startSignIn() })
  ipcMain.handle(WELCOME_IPC.cancel, async (event, id: unknown) => {
    assertSender(event)
    if (typeof id !== 'string') throw new Error('desktop welcome: invalid attempt')
    return operations.cancelSignIn(id as SignInAttemptId)
  })
  ipcMain.handle(WELCOME_IPC.copyLink, async (event, id: unknown) => {
    assertSender(event)
    if (typeof id !== 'string') throw new Error('desktop welcome: invalid attempt')
    return operations.copySignInLink(id as SignInAttemptId)
  })`, `  ipcMain.handle(WELCOME_IPC.enterWorkspace, async (event) => {
    assertSender(event)
    await operations.enterWorkspace()
  })`, 'welcome-window handler')

await patch(join(srcDir, 'welcome-window.ts'), 'if (active && !window.isDestroyed()) window.show()', `  if (active && !window.isDestroyed()) {
    window.show()
    void operations.analytics?.('auth_page_view', {})
  }`, `  if (active && !window.isDestroyed()) window.show()`, 'welcome-window show')

await patch(join(srcDir, 'welcome-window.ts'), 'the single action that hands off to the workspace', ` * @param operations - credential write and this-launch-only skip actions.`, ` * @param operations - the single action that hands off to the workspace.`, 'welcome-window doc')

// ── 7. locale.ts：先加两个按钮文案，再清掉官方授权面专属的死文案 ─────
//     （顺序要紧：清理会删掉 `welcomeApiKey`，而插入用的锚点正是它。）
const localePath = join(srcDir, 'locale.ts')
await patch(localePath, "welcomeUseLocal: 'Use locally'", `  welcomeSignIn: 'Sign in',
  welcomeApiKey: 'Add API Key',`, `  welcomeSignIn: 'Sign in',
  welcomeUseLocal: 'Use locally',
  welcomeApiKey: 'Add API Key',`, 'en copy')

await patch(localePath, "welcomeUseLocal: '本地使用'", `  welcomeSignIn: '登录',
  welcomeApiKey: '添加 API Key',`, `  welcomeSignIn: '登录',
  welcomeUseLocal: '本地使用',
  welcomeApiKey: '添加 API Key',`, 'zh copy')

// 审计发现的死代码：22 条 welcome 文案（授权状态页 / API Key 页 / 超时重试）在
// `WelcomePage` 收窄成品牌页后零引用。留着会让下一个人以为那些 UI 还在。
const deadCopy = new Set([
  'welcomeApiKey', 'welcomeAuthCancel', 'welcomeAuthCopied', 'welcomeAuthCopyFailed', 'welcomeAuthCopyLink',
  'welcomeAuthExchanging', 'welcomeAuthExpired', 'welcomeAuthExpiredDescription', 'welcomeAuthFailed',
  'welcomeAuthRetry', 'welcomeAuthStarting', 'welcomeAuthWaiting', 'welcomeAuthWaitingDescription',
  'welcomeContinueFailed', 'welcomeKeyBack', 'welcomeKeyBlank', 'welcomeKeyDescription', 'welcomeKeyFailed',
  'welcomeKeyInvalid', 'welcomeKeyLater', 'welcomeKeyPlaceholder', 'welcomeKeySave', 'welcomeKeyTitle',
  'welcomeSessionExpired',
])
{
  const lines = (await readFile(localePath, 'utf8')).split('\n')
  const kept = lines.filter((line) => {
    const match = /^\s+(welcome\w+):/u.exec(line)
    return match === null || !deadCopy.has(match[1])
  })
  if (kept.length !== lines.length) {
    await writeFile(localePath, kept.join('\n'))
    applied += 1
  } else skipped += 1
}

// ── 8. main.ts：标记路径 + 统一判据 + 交接 + 账号监听收窄 ─────────────
const mainPath = join(srcDir, 'main.ts')

await patch(mainPath, 'WELCOME_MARKER_NAME', `import { WELCOME_IPC, needsWelcome, type WelcomeNotice } from './welcome-api.ts'`,
  `import { needsWelcome } from './welcome-api.ts'
import { WELCOME_MARKER_NAME, markWelcomeCompleted, welcomeCompleted } from './welcome-marker.ts'`, 'marker import')

await patch(mainPath, 'const shouldShowWelcome', `  const readWelcomeState = async () => {
    if (backend.host === undefined || welcomeBackend === undefined) throw new Error('desktop welcome: backend unavailable')
    return welcomeBackend.read()
  }`, `  const readWelcomeState = async () => {
    if (backend.host === undefined || welcomeBackend === undefined) throw new Error('desktop welcome: backend unavailable')
    return welcomeBackend.read()
  }

  /**
   * The first-run marker's absolute path under \`userData\`.
   *
   * \`userData\` is the right home because the entry describes this **installation's**
   * first-run experience, not user data that follows the person (R-1).
   */
  const welcomeMarkerPath = (): string => join(app.getPath('userData'), WELCOME_MARKER_NAME)

  /**
   * Decide whether to show the native entry for the current facts.
   *
   * Every caller goes through here so the three inputs (Host state, product token,
   * first-run marker) are read consistently; a caller that assembles them by hand
   * would silently drop one and re-open the sign-out bug.
   * @param state - Host-reported account, API-key, and platform-token facts.
   * @returns true only before this installation has entered the workspace.
   */
  const shouldShowWelcome = (state: { loggedIn: boolean; hasApiKey: boolean; platformLoggedIn: boolean }): boolean =>
    needsWelcome({
      loggedIn: state.loggedIn,
      hasApiKey: state.hasApiKey,
      platformLoggedIn: state.platformLoggedIn,
      welcomeCompleted: welcomeCompleted(welcomeMarkerPath()),
    })`, 'welcome fact reader')

await patch(mainPath, 'markWelcomeCompleted(welcomeMarkerPath())', `  const enterWorkspace = async ({ activate = true }: { activate?: boolean } = {}): Promise<void> => {
    if (quitting) return
    const window = mainWindow ?? createMainWindow()`, `  const enterWorkspace = async ({ activate = true }: { activate?: boolean } = {}): Promise<void> => {
    if (quitting) return
    // Entering the workspace by any route ends the first-run experience, so the entry
    // never returns after a later sign-out (the marker, not the login state, is the fact).
    markWelcomeCompleted(welcomeMarkerPath())
    const window = mainWindow ?? createMainWindow()`, 'marker write')

await patch(mainPath, 'enterWorkspace })', `      welcomeWindow = await openWelcomeWindow(locale, {
        analytics: track,
        analyticsEnabled: () => Promise.resolve(analyticsEnabled),
        takeNotice: () => {
          const notice = pendingWelcomeNotice
          pendingWelcomeNotice = undefined
          return Promise.resolve(notice)
        },
        startSignIn: async () => {
          if (welcomeBackend === undefined) throw new Error('desktop welcome: backend unavailable')
          return welcomeBackend.account.start(desktopClientMetadata(locale.id))
        },
        cancelSignIn: async (id) => {
          if (welcomeBackend === undefined) throw new Error('desktop welcome: backend unavailable')
          return welcomeBackend.account.cancel(id)
        },
        copySignInLink: async (id) => {
          const state = await welcomeBackend?.account.state()
          if (state?.attempt?.id !== id || state.attempt.phase !== 'waiting-browser' || state.attempt.authorizeUrl === undefined) {
            throw new Error('desktop welcome: login link is unavailable')
          }
          await clipboard.writeText(platformLoginUrl(state.attempt.authorizeUrl))
        },
        saveApiKey: async (apiKey) => {
          if (backend.host === undefined || welcomeBackend === undefined) return { ok: false }
          const saved = await welcomeBackend.save(apiKey)
          if (!saved.ok) return saved
          await enterWorkspace()
          return { ok: true }
        },
        skip: enterWorkspace,
      })`, `      welcomeWindow = await openWelcomeWindow(locale, { enterWorkspace })`, 'welcome operations')

await patch(mainPath, 'no window is re-shown', `          if (welcomeWindow !== undefined && !welcomeWindow.isDestroyed()) welcomeWindow.webContents.send(WELCOME_IPC.state, state)
          const attempt = state.attempt`, `          // The official authorization flow stays functional (R-2): a waiting attempt opens
          // the browser, and a failed or expired one returns the user to the window that
          // started it. The first-run entry no longer drives this, so no window is re-shown.
          const attempt = state.attempt`, 'account watch head')

await patch(mainPath, 'A completed official sign-in also ends', `          if (state.status === 'credential-stored' && attempt?.phase === 'succeeded' && welcomeWindow !== undefined) void enterWorkspace({ activate: false }).catch(() => undefined)
          if (previousAccountStatus === 'credential-stored' && state.status === 'signed-out') {
            void readWelcomeState().then(async (value) => {
              if (needsWelcome(value) && !quitting) {
                enteredWorkspace = false
                await showWelcome()
                if (welcomeWindow !== undefined && !welcomeWindow.isDestroyed()) welcomeWindow.webContents.send(WELCOME_IPC.state, state)
              }
              return undefined
            }).catch(() => undefined)
          }
          previousAccountStatus = state.status`, `          // A completed official sign-in also ends the first-run experience.
          if (state.status === 'credential-stored' && attempt?.phase === 'succeeded' && welcomeWindow !== undefined) {
            void enterWorkspace({ activate: false }).catch(() => undefined)
          }`, 'account watch sign-out')

await patch(mainPath, 'the marker already covers', `        }, () => {
          void readWelcomeState().then(async (value) => {
            if (!needsWelcome(value) || quitting) return
            pendingWelcomeNotice = 'session-expired'
            enteredWorkspace = false
            await showWelcome()
            const state = await accountBackend.state()
            if (welcomeWindow !== undefined && !welcomeWindow.isDestroyed()) welcomeWindow.webContents.send(WELCOME_IPC.state, state)
          }).catch(() => undefined)
        }, (enabled) => { analyticsEnabled = enabled })`, `        }, () => {
          // An expired session must not replay the first-run entry: the marker already covers
          // that, and the product gate in the main window reports its own expiry.
        }, (enabled) => { analyticsEnabled = enabled })`, 'account watch expiry')

await patch(mainPath, 'shouldShowWelcome(state)', `    if (!enteredWorkspace && needsWelcome({ loggedIn: state.loggedIn, hasApiKey: state.hasApiKey })) {`,
  `    if (!enteredWorkspace && shouldShowWelcome(state)) {`, 'startup caller')

// 不再使用的局部状态与导入（welcome 不再下发状态、不再走剪贴板）。
await patch(mainPath, "import { needsWelcome } from './welcome-api.ts'", `import { WELCOME_IPC, needsWelcome, type WelcomeNotice } from './welcome-api.ts'`,
  `import { needsWelcome } from './welcome-api.ts'`, 'drop WELCOME_IPC import')

await patch(mainPath, '  let returnedAttempt: string | undefined\n  const assertProductSender', `  let pendingWelcomeNotice: WelcomeNotice | undefined
  let previousAccountStatus: string | undefined
`, ``, 'drop notice state')

await patch(mainPath, '  BrowserWindow,\n  dialog,', `  clipboard,
`, ``, 'drop clipboard import')

await patch(mainPath, 'enterWorkspace })', `        welcomeBackend = await connectDesktopWelcome(ready.url, (input, init) => net.fetch(input, init), async () => (await session.defaultSession.cookies.get({ url: ready.url })).map(cookie => \`\${cookie.name}=\${cookie.value}\`).join('; '))`,
  `        welcomeBackend = await connectDesktopWelcome(ready.url, (input, init) => net.fetch(input, init), async () => (await session.defaultSession.cookies.get({ url: ready.url })).map(cookie => \`\${cookie.name}=\${cookie.value}\`).join('; '))`, 'keep cookie reader')

// ── 9. 改写后的 welcome 测试（产品仓资产 → 内核树）───────────────────
//
// 官方授权页被整块删除后，内核自带的 `welcome-*.spec.ts` 全都指向不存在的 UI
// （`#api-key` / `#auth-page` / `saveApiKey`）。改写在 `branding/welcome-tests/`
// 里作为产品仓资产保存，这里覆盖进去——否则 CI 每次 clone 全新内核后重放补丁，
// 测试又变回指向已删 UI 的旧版。
const { writeWelcomeTests } = await import('./welcome-tests/index.mjs')
const writtenTests = writeWelcomeTests(join(kernelRoot, 'apps', 'desktop'))
if (writtenTests === 0) skipped += 1
else applied += writtenTests


// 欢迎页字标：方标（图）+ 产品名（HTML）。
//
// 原图是 472×40 的矢量字标（17 个 path 画成的字形），换品牌要重画字形；而 SVG `<text>`
// 在打包期用 libvips 栅格化时会因缺字体渲染成空白（本地实测）。所以：图只放 40×40 方标，
// 文字交给 Chromium 的系统字体 + CSS 变量（深浅色都跟主题）。
await patch(join(srcDir, 'client', 'WelcomePage.tsx'), 'brand-name', `<img className="brand" src="assets/welcome-brand.svg" alt={m.welcomeBrand} width="472" height="40" />`, `<div className="brand" role="img" aria-label={m.welcomeBrand}>
        <img className="brand-mark" src="assets/welcome-brand.svg" alt="" width="40" height="40" />
        <span className="brand-name">{m.welcomeBrand}</span>
      </div>`, 'WelcomePage brand lockup')


// 欢迎页字标的布局：.brand 从 block 改 flex（它现在装两个子元素）。
await patch(join(kernelRoot, 'apps', 'desktop', 'renderer', 'welcome.css'), '.brand-mark', `.brand {
  display: block;
  flex: none;
  width: 100%;
  height: 40px;
  user-select: none;
  -webkit-user-drag: none;
}`, `/* 字标 = 品牌标记（左）+ 产品名（右）。
   为什么不是单张 SVG：官方那张把字形画成矢量路径，换品牌要重画；用 <text> 又会在打包期
   栅格化时因缺字体变空白。拆开后标记走图、文字走 Chromium 的系统字体。 */
.brand {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  flex: none;
  width: 100%;
  height: 40px;
  user-select: none;
  -webkit-user-drag: none;
}

.brand-mark {
  flex: none;
  width: 32px;
  height: 32px;
  -webkit-user-drag: none;
}

.brand-name {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: 0.01em;
  color: var(--dsw-alias-label-primary);
}`, 'welcome.css brand lockup')

console.log(`welcome entry: ${String(applied)} 处已打补丁、${String(skipped)} 处已是最新`)
// 只改源码；重建与产物断言由 apply-welcome-entry-build.mjs 在 `build:official` 之后、
// `release:pack` 之前完成（与数据隔离同一个阶段约束：早了工作区 lib/ 未建齐，晚了产物已收）。

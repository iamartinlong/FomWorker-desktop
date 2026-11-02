/**
 * 办公平台的**技能层**（SKILL.md 提供者）：
 * - **bundled**：随包资产（`assets/<name>/SKILL.md`）——会议纪要 / 周报；
 * - **managed**（C3）：`$DSH_HOME/office/skills/<slug>/SKILL.md`——**用户自建**技能，装/卸即写/删文件。
 * 两者都经 `ctx.skills.registerProvider` 挂进内核 `ctx.skills`（形状抄内核 `skill-office`）。
 *
 * 技能本身只是给模型的**指令**；它调用的能力来自 `office-feishu` 与内核自带工具。技能不引入任何新工具、
 * 也不放宽任何闸。
 */

import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BUNDLED_SKILL_RANK, type SkillCandidate, type SkillProvider } from '@deepseek-ai/dsh-skill'
import { listManagedSkills, MANAGED_SKILLS_DIR, parseSkillFrontmatter, readManagedSkill, skillBody } from './managed.ts'
import { materializePlatformSkills, PLATFORM_SKILLS_DIR, readApplied, writeApplied, type MaterializeResult } from './platform.ts'

export * from './managed.ts'
export * from './platform.ts'

/** 本层随包提供的技能名（与 `assets/<name>/SKILL.md` 一一对应）。 */
const SKILLS = [
  {
    name: 'meeting-minutes',
    // 中文名前置（`/` 菜单主标签只能是 kebab-case 标识，故把中文展示名放进描述——菜单会显示）。
    description: '会议纪要分发 —— 把会议记录/转录整理成结构化会议纪要并分发：给出结论与待办（含负责人、期限），可发布为飞书云文档。当输入是会议录音转录、会议纪要文档，或用户要求「整理/分发会议纪要」时使用。',
  },
  {
    name: 'weekly-report',
    description: '周报汇总 —— 汇总一周工作数据（多维表格记录 / 日历日程 / 工作区文件）生成结构化周报，可发布为飞书云文档。当用户要求「写周报 / 汇总本周工作」或提供了多维表格、日历数据时使用。',
  },
] as const

/** 受管（用户自建）技能的优先级：数值越小越先胜出 ⇒ `500 < 600`，同名时**用户技能覆盖随包技能**（本地优先）。 */
const MANAGED_SKILL_RANK = 500

/** 平台下发技能的优先级：`500 < 550` ⇒ 同名时**用户自建覆盖平台下发**（本地优先），平台下发覆盖随包。 */
const PLATFORM_SKILL_RANK = 550

export interface OfficeSkillsConfig {
  /** 随包技能资产根目录（含各 `<name>/SKILL.md`）；缺省用随包的 `assets/`。 */
  assetRoot: string
  /** 受管技能根（用户自建）；缺省 `$DSH_HOME/office/skills`。 */
  managedRoot: string
  /** 平台下发技能根（C5）；缺省 `$DSH_HOME/office/platform-skills`。 */
  platformRoot: string
  /** 平台 API 基址（C5 sync 用；缺省本机 dev `http://localhost:5028`）。 */
  platformUrl: string
  /**
   * **技能过滤**（C4b）：非空时**只列这些技能**（按名）。
   * 用作 agent preset 行时，专家组合挂本 provider 会**覆盖全局同名 provider**（内核作用域最近层胜出）
   * ⇒ 专家只带选中技能。缺省＝不过滤（列全部）。
   */
  skills: string[]
}

const Config: z<OfficeSkillsConfig> = z.object({
  assetRoot: z.string().default(''),
  managedRoot: z.string().default(''),
  platformRoot: z.string().default(''),
  platformUrl: z.string().default('http://localhost:5028'),
  skills: z.array(z.string()).default([]),
})

export const name = 'office-skills'
export const inject = ['skills']

/**
 * 造出**随包**技能提供者（与 `apply` 拆开，便于单测直接验 list/get，不必起 cordis）。
 * @param assetRoot - 技能资产根目录（绝对路径）。
 * @param filter - 技能名过滤（非空时只列这些；C4b）。
 * @returns 内核 `ctx.skills` 认的 `SkillProvider`。
 */
export function createOfficeSkillsProvider(assetRoot: string, filter: readonly string[] = []): SkillProvider {
  if (!isAbsolute(assetRoot)) throw new Error('office-skills: assetRoot 必须是绝对路径')
  const selected = filter.length === 0 ? SKILLS : SKILLS.filter((skill) => filter.includes(skill.name))
  const candidates: SkillCandidate[] = selected.map((skill) => {
    const directory = join(assetRoot, skill.name)
    const path = join(directory, 'SKILL.md')
    // 挂载时校验 SKILL.md 在场：缺了要**响亮抛**，不静默装一个没有正文的技能。
    readFileSync(path, 'utf8')
    return {
      name: skill.name,
      description: skill.description,
      invocation: { modelInvocable: true, userInvocable: true },
      provider: 'dsh-office-platform',
      source: 'bundled',
      rank: BUNDLED_SKILL_RANK,
      resourceBase: { kind: 'directory', path: directory },
      locator: path,
    }
  })
  return {
    name: 'dsh-office-platform',
    list: () => Promise.resolve(candidates),
    async get(candidate, options) {
      const { rank: _rank, locator, ...summary } = candidate
      const raw = await readFile(locator as string, { encoding: 'utf8', signal: options.signal })
      return { ...summary, content: skillBody(raw) }
    },
  }
}

/**
 * 造**受管技能**提供者：每次 `list()` 现扫受管根（装/卸即时生效，不必重启）。
 * @param managedRoot - 受管技能根目录（绝对路径）。
 * @param filter - 技能名过滤（非空时只列这些；C4b）。
 * @returns 内核 `ctx.skills` 认的 `SkillProvider`。
 */
export function createManagedSkillsProvider(managedRoot: string, filter: readonly string[] = []): SkillProvider {
  if (!isAbsolute(managedRoot)) throw new Error('office-skills: managedRoot 必须是绝对路径')
  return {
    name: 'dsh-office-managed-skills',
    list: () => Promise.resolve(listManagedSkills(managedRoot)
      .filter((slug) => filter.length === 0 || filter.includes(slug))
      .map((slug): SkillCandidate => {
      const directory = join(managedRoot, slug)
      const raw = readManagedSkill(managedRoot, slug) ?? ''
      const meta = parseSkillFrontmatter(raw)
      return {
        name: slug,
        description: meta.description ?? meta.name ?? slug,
        invocation: { modelInvocable: true, userInvocable: true },
        provider: 'dsh-office-managed-skills',
        source: 'custom',
        rank: MANAGED_SKILL_RANK,
        resourceBase: { kind: 'directory', path: directory },
        locator: join(directory, 'SKILL.md'),
      }
    })),
    async get(candidate, options) {
      const { rank: _rank, locator, ...summary } = candidate
      const raw = await readFile(locator as string, { encoding: 'utf8', signal: options.signal })
      return { ...summary, content: skillBody(raw) }
    },
  }
}

/**
 * 造**平台下发技能**提供者（C5）：每次 `list()` 现扫平台根（sync 后即时生效）。
 * @param platformRoot - 平台下发技能根目录（绝对路径）。
 * @param filter - 技能名过滤（非空时只列这些；C4b）。
 * @returns 内核 `ctx.skills` 认的 `SkillProvider`。
 */
export function createPlatformSkillsProvider(platformRoot: string, filter: readonly string[] = []): SkillProvider {
  if (!isAbsolute(platformRoot)) throw new Error('office-skills: platformRoot 必须是绝对路径')
  return {
    name: 'dsh-office-platform-skills',
    list: () => Promise.resolve(listManagedSkills(platformRoot)
      .filter((slug) => filter.length === 0 || filter.includes(slug))
      .map((slug): SkillCandidate => {
        const directory = join(platformRoot, slug)
        const raw = readManagedSkill(platformRoot, slug) ?? ''
        const meta = parseSkillFrontmatter(raw)
        return {
          name: slug,
          description: meta.description ?? meta.name ?? slug,
          invocation: { modelInvocable: true, userInvocable: true },
          provider: 'dsh-office-platform-skills',
          source: 'platform',
          rank: PLATFORM_SKILL_RANK,
          resourceBase: { kind: 'directory', path: directory },
          locator: join(directory, 'SKILL.md'),
        }
      })),
    async get(candidate, options) {
      const { rank: _rank, locator, ...summary } = candidate
      const raw = await readFile(locator as string, { encoding: 'utf8', signal: options.signal })
      return { ...summary, content: skillBody(raw) }
    },
  }
}

/** 解析 `$DSH_HOME`（与内核一致：环境变量优先，否则 `~/.dsh`）。 */
function dshHome(): string {
  const home = process.env.DSH_HOME
  return home !== undefined && home !== '' ? home : join(homedir(), '.dsh')
}

/** 技能服务面（供控制台等消费：新建/删除受管技能后**失效技能收集缓存**）。 */
export interface OfficeSkills {
  /**
   * 重新注册受管 provider ⇒ 内核技能注册表 `revision` 前移、**清空收集缓存**
   * ⇒ 新建/删除技能后**新会话即时可见**（否则 `collect` 命中按 `(cwd,scope,revision)` 的旧缓存）。
   */
  refresh(): void
  /** C5：拉平台目录（`/api/config/catalog`）→ 物化平台技能 → 刷新注册表。 */
  sync(): Promise<MaterializeResult>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** 技能刷新口（由 `office-skills` 提供）。 */
    officeSkills: OfficeSkills
  }
}

/**
 * 解析随包 `assets/` 目录，兼容代码的三种落点：包根 `index.ts`（tsx 直跑）、`src/index.ts`、
 * 构建产物 `lib/index.js`（打包运行时）。按候选顺序取**第一个存在**的。
 * @param moduleUrl - `import.meta.url`。
 * @returns `assets/` 绝对路径。
 */
export function resolveBundledAssets(moduleUrl: string): string {
  for (const relative of ['./assets/', '../assets/']) {
    const directory = fileURLToPath(new URL(relative, moduleUrl))
    if (existsSync(directory)) return directory
  }
  // 都不在：回落到 `./assets/`（让下游报出真实的 ENOENT 路径，便于排查）。
  return fileURLToPath(new URL('./assets/', moduleUrl))
}

/** 平台令牌的凭据 ref（与 `office-login` 同一名）。 */
export const PLATFORM_TOKEN_REF = 'FOM_PLATFORM_TOKEN'

/** C5 同步路由（认证的 `/api` 通道）。 */
export const SYNC_ROUTE = '/api/office/skills/sync'

/** `connection` 服务的最小面（认证 Fetch 路由）。 */
interface ConnectionLike {
  fetch: {
    register(route: {
      path: string
      methods: readonly string[]
      requestBody: 'buffered' | 'streaming'
      fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

export function apply(ctx: Context, config: OfficeSkillsConfig): void {
  const assetRoot = config.assetRoot === ''
    ? resolveBundledAssets(import.meta.url)
    : config.assetRoot
  const managedRoot = config.managedRoot === ''
    ? join(dshHome(), 'office', MANAGED_SKILLS_DIR)
    : config.managedRoot
  const platformRoot = config.platformRoot === ''
    ? join(dshHome(), 'office', PLATFORM_SKILLS_DIR)
    : config.platformRoot
  const platformUrl = config.platformUrl.replace(/\/+$/u, '')
  ctx.effect(() => {
    const disposeBundled = ctx.skills.registerProvider(() => createOfficeSkillsProvider(assetRoot, config.skills))
    const registerManaged = (): (() => void) =>
      ctx.skills.registerProvider(() => createManagedSkillsProvider(managedRoot, config.skills))
    const registerPlatform = (): (() => void) =>
      ctx.skills.registerProvider(() => createPlatformSkillsProvider(platformRoot, config.skills))
    let disposeManaged = registerManaged()
    let disposePlatform = registerPlatform()
    /** 注销 + 重注册两个受管 provider（触发注册表 `invalidateCache` ⇒ `revision` 前移 + 清缓存）。 */
    const refresh = (): void => {
      disposeManaged()
      disposeManaged = registerManaged()
      disposePlatform()
      disposePlatform = registerPlatform()
    }
    const sync = async (): Promise<MaterializeResult> => {
      const credentials = ctx.get('credentials') as { resolve?: (ref: string) => Promise<{ value: string } | undefined> } | undefined
      const token = (await credentials?.resolve?.(PLATFORM_TOKEN_REF))?.value ?? ''
      const headers: Record<string, string> = { accept: 'application/json' }
      if (token !== '') headers.authorization = `Bearer ${token}`
      const res = await fetch(`${platformUrl}/api/config/catalog`, { headers })
      if (!res.ok) throw new Error(`平台目录下发失败：HTTP ${res.status}`)
      const payload = (await res.json()) as unknown
      // **版本判定 / 增量**：只写新/变了的，未变的跳过；剪掉撤下的；落「已物化」表。
      const result = materializePlatformSkills(platformRoot, Array.isArray(payload) ? payload : [], readApplied(platformRoot))
      writeApplied(platformRoot, result.applied)
      refresh()
      return result
    }
    const disposeService = ctx.reflect.provide('officeSkills', { refresh, sync })
    return () => {
      disposePlatform()
      disposeManaged()
      disposeBundled()
      disposeService()
    }
  })
  // C5 同步路由：`POST /api/office/skills/sync` → 拉平台目录 + 物化（认证的 `/api` 通道）。
  ctx.inject(['connection'], (connCtx) => {
    connCtx.effect(() => {
      const conn = connCtx.get('connection') as ConnectionLike | undefined
      if (conn === undefined) return () => {}
      const dispose = conn.fetch.register({
        path: SYNC_ROUTE,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async () => {
          const service = ctx.get('officeSkills') as OfficeSkills | undefined
          if (service === undefined) {
            return new Response(JSON.stringify({ ok: false, message: 'officeSkills 服务缺失' }), { status: 500, headers: { 'content-type': 'application/json' } })
          }
          try {
            const result = await service.sync()
            return new Response(JSON.stringify({ ok: true, ...result }), { status: 200, headers: { 'content-type': 'application/json' } })
          } catch (error) {
            return new Response(JSON.stringify({ ok: false, message: String((error as Error)?.message ?? error) }), { status: 200, headers: { 'content-type': 'application/json' } })
          }
        },
      })
      return () => {
        void dispose()
      }
    }, 'office-skills: C5 平台目录同步路由')
  })
}

export const OfficeSkills = {
  name,
  inject,
  Config,
  apply,
}

export default OfficeSkills

/**
 * 控制面**编排辅助**（M2/B · O-P0 运行侧）：把「怎么起一个数据面 dsh web、怎么判它就绪、怎么从日志取地址」
 * 从设计稿落成可执行、可测的纯函数。真正的 spawn/重启循环由控制面脚本调用这些函数。
 *
 * 依据：`docs/02-设计/部署与运维形态设计v0.1.md`（O1 旗标顺序、O3 `DSH_HOME` bootstrap-only、O8 就绪判据）。
 * **旗标顺序**：`--patch`（launcher）必须排在 `--no-open`/`--port`（应用旗标）之前（O1）。
 */

/** `dsh web` 的启动规格。 */
export interface WebLaunchSpec {
  /** 该租户的 `$DSH_HOME`（进程 env 注入，bootstrap-only）。 */
  homeDir: string
  port: number
  /** 绝对路径的 patch 列表（launcher 旗标，排在前）。 */
  patches?: readonly string[]
  /** 是否 `--no-open`（默认 true：控制面不弹浏览器）。 */
  noOpen?: boolean
  /** node 侧旗标（默认 `['--import','tsx/esm']`）。 */
  nodeArgs?: readonly string[]
  /** 应用入口（默认 `apps/cli/src/bin.ts`）。 */
  appEntry?: string
}

const DEFAULT_NODE_ARGS: readonly string[] = ['--import', 'tsx/esm']
const DEFAULT_APP_ENTRY = 'apps/cli/src/bin.ts'

/**
 * 拼 `dsh web` 的完整 argv（**不含** `node` 自身，调用方用 `process.execPath` + 这些参数）。
 * 顺序：node 旗标 → 应用入口 → `web` → `--patch…` → `--no-open` → `--port`。
 * @param spec - 启动规格。
 * @returns argv 数组。
 */
export function buildWebArgs(spec: WebLaunchSpec): string[] {
  const args = [...(spec.nodeArgs ?? DEFAULT_NODE_ARGS), spec.appEntry ?? DEFAULT_APP_ENTRY, 'web']
  for (const patch of spec.patches ?? []) args.push('--patch', patch)
  if (spec.noOpen ?? true) args.push('--no-open')
  args.push('--port', String(spec.port))
  return args
}

/**
 * 数据面进程的环境：在给定基线上注入 `DSH_HOME`。
 * @param spec - 启动规格。
 * @param base - 基线环境（默认 `process.env`）。
 * @returns 新的环境对象。
 */
export function buildWebEnv(spec: WebLaunchSpec, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, DSH_HOME: spec.homeDir }
}

/** 就绪判据：`/`（或 `/api`）返回 **401**（已启动、需鉴权）或 **200**。 */
export function isReadyStatus(status: number): boolean {
  return status === 401 || status === 200
}

/**
 * 从一行日志里取 `dsh web: <url>` 的地址。
 * @param line - 一行文本。
 * @returns URL 字符串；无则 `undefined`。
 */
export function parseWebUrl(line: string): string | undefined {
  const match = /dsh web:\s*(https?:\/\/\S+)/.exec(line)
  return match === null ? undefined : match[1].replace(/[.,)]+$/, '')
}

/**
 * 从整段日志文本里取**最后一个** `dsh web:` 地址（重启后取新的）。
 * @param logText - 日志文本。
 * @returns URL；无则 `undefined`。
 */
export function findWebUrl(logText: string): string | undefined {
  let found: string | undefined
  for (const line of logText.split(/\r?\n/)) {
    const url = parseWebUrl(line)
    if (url !== undefined) found = url
  }
  return found
}

/** 编排目标（每个租户一个 home）。 */
export interface OrchestrationTarget {
  readonly tenantId: string
  readonly homeDir: string
}

/** 一个租户的启动计划。 */
export interface LaunchPlan {
  readonly tenantId: string
  readonly spec: WebLaunchSpec
}

/**
 * 为若干租户生成**启动计划**（端口从 `basePort` 顺延分配；每租户独立 `homeDir`）。
 * 纯函数：只算规格，不 spawn、不抢锁（调用方对每个 home 先 `acquireHomeLock` 再起）。
 * @param targets - 租户目标。
 * @param options - 起始端口与公共参数。
 * @returns 每个租户的启动计划。
 */
export function planLaunches(
  targets: readonly OrchestrationTarget[],
  options: { basePort: number; patches?: readonly string[]; noOpen?: boolean },
): LaunchPlan[] {
  return targets.map((target, index) => ({
    tenantId: target.tenantId,
    spec: {
      homeDir: target.homeDir,
      port: options.basePort + index,
      ...(options.patches !== undefined ? { patches: options.patches } : {}),
      ...(options.noOpen !== undefined ? { noOpen: options.noOpen } : {}),
    },
  }))
}

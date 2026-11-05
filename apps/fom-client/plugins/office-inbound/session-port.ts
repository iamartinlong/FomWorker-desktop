/**
 * 内核**建会话口**适配器（M2/C · 层①）：把控制台的 `CreateSessionPort` 结构化接到内核的会话创建。
 *
 * 用**结构化**类型（只取 `create`），不依赖内核包类型导出；真实现由传输方用 `ctx.agents`/`sessionController` 提供
 * （把 `{cwd, agentPreset, prompt, identityNotice}` 落成 `meta.cwd`/`meta.agentPreset` 与作用域内的 `systemPrompt.section`）。
 *
 * 依据：`docs/02-设计/路由与权限模型设计v0.1.md` §4。
 */

import type { CreateSessionPort } from './inbound.ts'

/** 内核会话创建服务的最小面（结构化）。 */
export interface SessionCreatorLike {
  create(request: {
    readonly cwd: string
    readonly agentPreset: string
    readonly prompt: string
    readonly identityNotice: string
  }): Promise<{ sessionId: string }>
}

/**
 * 造内核建会话口。
 * @param creator - 内核会话创建服务（结构化）。
 * @returns `CreateSessionPort`。
 */
export function createKernelSessionPort(creator: SessionCreatorLike): CreateSessionPort {
  return {
    create: (request) => creator.create({
      cwd: request.cwd,
      agentPreset: request.agentPreset,
      prompt: request.text,
      identityNotice: request.identityNotice,
    }),
  }
}

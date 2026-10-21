# fom-contracts · 共享契约（前置）

> **⓪ 三 app 的接口基线**（先定解锁并行）。目录 `packages/fom-contracts`。
> 计划：`docs/02-设计/实施计划-契约v0.1.md`。

## 内容

| 文件 | 说明 |
|---|---|
| `openapi/platform.yaml` | **PLATFORM API**（运营平台对外）：登录/令牌、上报、拉配置、管理。 |
| `openapi/gateway.yaml` | **GATEWAY API**：OpenAI 兼容（`/v1/chat/completions`）+ 平台→网关内部配置端点。 |
| `ws/client-platform.schema.json` | **client ↔ PLATFORM WS 协议**：上报 / 下发 / IM 中继消息。 |

## 约定

- 格式：**OpenAPI 3.1** + **JSON Schema**。
- 版本化：`info.version`（`0.x`）；**变更走 PR**（`fom-contracts` 为唯一真相源）。
- 鉴权：Bearer 令牌（平台）；网关 OpenAI 兼容端点用平台令牌。
- 状态：**骨架草案**（C0）；后续按 C1–C4 细化 + mock server。

---
name: "别在 office-platform 根目录装包"
description: "在自研根目录 pnpm install 会悄悄塞进第二份内核，跨实例 instanceof 与服务键全炸"
type: "feedback"
source: "session"
createdAt: "2026-10-08T09:00:00"
bodySha256: "631b349ffee09fc3ad1ea12439ab10e8b8c7d7461c22eaa13d8d89aa50090685"
---
规则：office-platform 根目录永远不装依赖，外部 SDK 装进各自的点目录（如 .spike/feishu-ws/node_modules）。

Why: 出现过一次「绿了半天，是两个内核在互相看不见」。
How to apply: 要加依赖先问能不能用 junction 指回主内核。

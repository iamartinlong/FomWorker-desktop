---
name: "别在 office-platform 根目录装包"
description: "根目录装依赖会塞进第二份内核，跨实例 instanceof 全炸"
type: "feedback"
source: "session"
createdAt: "2026-10-10T02:00:00.000Z"
bodySha256: "e68aa97f9105d27ed9f9ef43e0fbc9ec54919696793cf488ab8d687e73983ce6"
---

规则：自研根目录永远不装依赖，外部 SDK 装进各自点目录。

Why: 出现过「绿了半天是两个内核互相看不见」。
How to apply: 要加依赖先问能不能 junction 指回主内核。

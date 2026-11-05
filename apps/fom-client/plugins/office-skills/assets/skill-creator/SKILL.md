---
name: skill-creator
description: 技能创建助手 —— 在本机快捷创建「用户自建技能」：讲清三个技能根与优先级、$DSH_HOME 怎么解析、SKILL.md 的形状与 slug 规则、三条创建路径（write 工具 / 控制台端点 / UI）与各自生效时机、写完怎么验证（新开会话可见、不用重启）、以及删除/导出/导入。当用户要求「新建/写一个技能」「把某段工作流固化成技能」「技能放哪/怎么生效」时使用。
---

# 技能创建助手

把「怎么建一个技能」一次讲全：**位置、形状、路径、生效时机、验证方法**。
按本技能做，不必再去翻仓库文档。

## 1. 三个技能根与优先级

所有根都在 `$DSH_HOME` 下。**同名技能按 rank 决胜，数值越小越先胜出**：

| 类型 | source | rank | 位置 | 谁写 |
|---|---|---|---|---|
| 随包（bundled） | `bundled` | 600 | `apps/fom-client/plugins/office-skills/assets/<name>/SKILL.md` | 开发者，随安装包发布 |
| **用户自建（managed）** | `custom` | **500** | `$DSH_HOME/office/skills/<slug>/SKILL.md` | 用户 / agent ← **本技能的主战场** |
| 平台下发（platform） | `platform` | 550 | `$DSH_HOME/office/platform-skills/<slug>/SKILL.md` | 平台目录同步 |

⇒ **用户自建盖过随包与平台下发**（本地优先）。要改一个随包技能的行为，
在受管根建一个同名的即可，不用去改安装包里的文件。

**解析 `$DSH_HOME`（动态取，不要写死路径）**：环境变量 `DSH_HOME` 优先，
否则 `~/.dsh`。FomWorker 装机版被数据隔离钉在 `%APPDATA%\FomWorker\dsh-home`。
拿不准就先跑一条命令确认（如 `echo $env:DSH_HOME` / `echo $DSH_HOME`），
或直接问运行时，**别把某台机器的绝对路径写进技能正文**。

## 2. SKILL.md 的形状

一个技能＝**一个目录 + 一个文件**：`<root>/<slug>/SKILL.md`。

```
---
name: 展示名（可中文）
description: 什么时候该用本技能——菜单与模型都靠它决定要不要调用，写清楚触发场景
---

# 正文标题

（给模型的指令：工作流、产出形状、纪律）
```

四条必须知道的事实：

- **slug 作目录名**，规则 `^[a-z0-9][a-z0-9._-]*$`：小写字母数字开头，
  只允许 `.` `_` `-`。**大写、空格、中文一律非法**（会在输入边界被拒）。
- **受管技能的标识就是 slug（目录名）**；frontmatter 的 `name` 只是 description 的兜底，
  **菜单显示的是 `description`**，没有 description 才退到 `name`、再退到 slug。
- **`/` 菜单的主标签只能是 kebab-case 标识**，所以**中文展示名要放进 description**
  （随包技能一直这么做），否则菜单里只看到一串英文 slug。
- frontmatter 用 `---` 包夹、`name`/`description` 各占一行；正文紧随其后。
  写完后 frontmatter 会被剥掉，模型只看到正文。

⚠️ **随包技能是例外**：它的 description 写在 `office-skills/index.ts` 的 `SKILLS` 数组里，
**不读 frontmatter**。改 `assets/<name>/SKILL.md` 里的 description 对界面零影响——
只有受管 / 平台下发两个根读 frontmatter。

## 3. 三条创建路径

| 路径 | 怎么做 | 生效时机 | 前提 |
|---|---|---|---|
| **A. agent 的 write 工具**（推荐） | 直接写 `$DSH_HOME/office/skills/<slug>/SKILL.md` | **同一会话内**即时生效 | 无 |
| B. 控制台写端点 | `POST /api/office/console/action`，body `{"action":"skill.create","payload":{"slug":"…","name":"…","description":"…","body":"…"}}` | 即时 | 需登录；owner/admin/member 均可，**不需审批** |
| C. 控制台 UI | 「专家·技能·连接器」页 → 技能 → 新建 | 即时 | 同上 |

路径 A 为什么即时：受管根挂了目录监听 + 接了内核 `fs/observed`，
写入会触发一次刷新，把技能收集缓存清掉。

**技能正文里该写什么**：工作流步骤、产出形状、**纪律**（不编造 / 不代替决策 /
凭据不入正文 / 工具分级）。技能只是**给模型的指令**——
它**不引入任何新工具、也不放宽任何闸**；需要写飞书这类对外动作，照旧弹审批卡，
不要试图绕过。

## 4. 写完怎么验证

1. **不要重启应用**——重启能掩盖问题（进程重建会清缓存，旧 bug 就是这样被藏住的）。
2. **新开一个会话**，看技能列表里有没有刚建的那条。
3. 或者直接问 agent：「你现在有哪些技能？」——它应能列出并附上你的 description。

看不到 ⇒ 按顺序查：slug 是否非法、文件是否真在 `<root>/<slug>/SKILL.md`、
frontmatter 是否被 `---` 正确包夹、`description` 是否缺失。

## 5. 删除 / 导出 / 导入

- **删**：`skill.remove`（payload `{slug}`），或直接删掉整个 `<root>/<slug>/` 目录。
- **导出**：`skill.export`（payload `{slug}`）⇒ 得到 portable 技能包
  （`kind:'fom-skill'` + `version` + 解析时未知键静默忽略），可分享。
- **导入**：`skill.import`（payload `{bundle}`）⇒ 同 `slug` 已存在会 409。

三条都走路径 B 那个端点，都需要登录。

## 6. 纪律

- **先问清再写**：slug、展示名、触发场景（description）三项缺一项就别动手——
  特别是 description，它决定模型什么时候调用这个技能。
- **不写死机器路径**：技能正文里出现 `$DSH_HOME` 要教怎么解析，不是抄某台机器的绝对路径。
- **技能不是工具**：不要指望通过技能「增加能力」；能力来自工具与插件，技能只是编排指令。
- **正文保持可读**：一段工作流一件事；超过一屏就该拆成两个技能。

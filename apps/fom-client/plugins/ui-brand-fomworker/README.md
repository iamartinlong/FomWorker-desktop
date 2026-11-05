# @fominfo/dsh-client-ui-brand-fomworker

FomWorker 品牌 occupant（客户端插件，**out-of-tree，零内核改动**）。

占三个内核槽位：
- `sidebar.brand.mark` —— 侧栏 logo
- `sidebar.brand.name` —— 侧栏名称
- `conversation.hero.brand.mark` —— 聊天页 hero 标志

## 构建

```sh
# node_modules 为指向内核 node_modules 的 junction（见仓库 .gitignore 约定）
node_modules/.bin/tsdown      # 产出 lib/index.js（node half）+ lib/client.js（browser half）
```

## 挂载（阶段1）

1. 包解析：junction `C:\Users\EDY\.dsh\profiles\node_modules\@fominfo\dsh-client-ui-brand-fomworker` → 本目录。
2. profile patch（`$DSH_HOME/profiles/web/cordis.patch.yml`）加行：
   ```yaml
   - insert:
       - id: ui-brand-fomworker
         name: '@fominfo/dsh-client-ui-brand-fomworker'
   ```
3. 非 `official` profile（官方 `ui-brand-official` 不注册）；标题 `DSH_CLIENT_TITLE=FomWorker`（构建期）。

## Model Experience

None —— 纯浏览器展示，不影响模型请求。

## 阶段1 说明

- logo/名称/hero 为**占位几何**；后续替换为 `fom-logo` 转出的 SVG。
- 参考 `docs/02-设计/阶段1品牌改造方案v0.1.md`。

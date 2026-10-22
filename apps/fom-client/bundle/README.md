# @fominfo/dsh-bundle-fomworker

FomWorker 的 **profile bundle**（一层 patch），把以下行挂进 dsh profile：

- `ui-brand-fomworker` —— FomWorker 品牌 occupant（侧栏 logo/名称 + 聊天页 hero 标志槽位）
- `office-catalog` / `office-authz` / `office-console` —— 办公平台能力目录 + 控制台（技能/专家/连接器 UI）

替代原先手工写在 `~/.dsh/profiles/web/cordis.patch.yml` 里的 insert 行。

## 接线（out-of-tree）

1. 解析：junction `~/.dsh/profiles/node_modules/@fominfo/dsh-bundle-fomworker` → 本目录。
2. 选入：在 `~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles` 里加 `"@fominfo/dsh-bundle-fomworker"`。
3. 生效：重启 dsh 服务。

> 也可用正规路径 `dsh plugin --profile web add <本目录绝对路径>`（写 profile 的 package.json + node_modules，跨重启生效）。

## 说明

- 办公插件在 `apps/fom-client/plugins/`，patch 用**相对本文件的路径**（`../plugins/...`）；品牌/登录走**包名**（junction 进 profile node_modules 的 `@fominfo/*`）。

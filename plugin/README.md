# devflow 看板的 DSH 薄框（可选）

> **这不是工作流的一部分。** 删掉本目录，devflow 的全部能力（27 个命令、门禁、确认点、看板）**不受任何影响**。
>
> 它只做一件事：把 `devflow board` 的本地页面**内嵌进 DSH 界面**，让你能和聊天并排看。

## 它解决什么

| 之前 | 之后 |
|---|---|
| 看板要在浏览器另开窗口，与聊天来回切换 | 在 DSH **右栏标签页**里，与聊天并排 |

**看板的渲染、数据、实时刷新全部仍在 `devflow board`** —— 本插件只是一个 `iframe` 窗口，
不读 `.devflow/`、不调 CLI、不含任何业务逻辑。**这样才不会出现"两份看板实现"**。

## 架构（与主仓的边界）

```
devflow CLI + spec/*.json + .devflow/     ← 唯一事实源（零依赖、无构建）
        ↓
devflow board（本地服务，127.0.0.1:8787）  ← 唯一的看板实现
        ↓ iframe
本插件（React 组件 + 标签页注册）           ← 只做窗口，可删
```

## 已核实的插件契约

以下全部来自**真实源码**（不是猜测），取证位置写在括号里：

| 契约 | 内容 |
|---|---|
| **清单** | `dsh.client = { inject: [...], platform: "web" }`、`exports["./client"]`（取自 `dsh-client-ui-sidebar-right/package.json`） |
| **注册标签页类型** | `ctx.sidebarRightTabs.register({ id, kind, title, patterns?, ... })` 返回 disposer（取自 `sidebar-right` 的 README「Extension seats」） |
| **注册标签页内容** | `ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name, key }, Body))`（取自 `dsh-client-ui-sidebar-documentpreview/lib/client.js` 的真实调用） |
| **生命周期** | 每次注册都包在 `ctx.effect(...)` 里，随插件销毁 |
| **React 来源** | 各插件在**构建期**自行打包 React（核实：`dsh-client-ui-renderer` 的 client 产物里有 `require("react")`） |

**第三方插件能注册标签页的活证据**：`ui-sidebar-documentpreview` 是**产品之外的包**，
它用**同一套公开路径**注册了 `sidebar.right.pane.tab`。所以这条路径对第三方开放。

## 构建与安装

```bash
cd plugin
npm i -D esbuild react       # 依赖隔离在 plugin/，主仓仍零依赖
node tools/build.mjs         # → lib/client.js（约 80 KB）

# 装进 DSH（需要 pnpm；可用 corepack enable pnpm 提供）
dsh plugin --profile web add "$PWD"
```

## ⚠️ 尚未验证的边界（如实登记）

| # | 未验证项 | 影响 |
|---|---|---|
| 1 | **`bundle` 声明的确切格式** | 插件管理器文档提到"**只管理 bundle**：依赖里没有 bundle patch 的会被拒绝安装"。`package.json` 里的 `dsh.bundle` 是我按语义写的，**格式未经验证** —— 若安装被拒，先修这里 |
| 2 | **端到端加载** | 我没有在真实 DSH 里装过它（见下面「环境的两个限制」），**所以"能在界面里显示"目前是设计推断，不是实测** |
| 3 | **iframe 是否被 CSP 允许** | DSH 界面里有 126 处 `iframe` 用法，说明机制可用；但**是否允许指向 `http://127.0.0.1:8787` 未验证** |
| 4 | **标签页如何被打开** | 页面型标签（无 `patterns`）**如何进入用户视野**（侧栏 guide？命令？）未验证 |

## 环境的两个限制（这就是我无法替你验证的原因）

| 限制 | 后果 |
|---|---|
| **`desktop` profile 被 Electron 应用独占管理** | CLI 不能往里装（`error: profile "desktop" is managed exclusively by the Electron application`）。而你正在用的 GUI 就是 desktop ⇒ **要走 GUI 的「添加插件」** |
| **`dsh plugin add` 需要 pnpm** | 当前 PATH 上没有 pnpm（`corepack enable pnpm` 可提供） |

## 建议的下一步（按顺序）

1. 在 DSH GUI 里走 **「添加插件」**，填本目录的绝对路径（GUI 支持本地绝对路径）；
2. 看是否安装成功 —— **若被拒，把报错贴给我**，那就是第 1 条未验证项（`bundle` 格式）；
3. 装成功后看右栏是否出现「devflow 看板」，内容是否为看板页面（第 3、4 条）；
4. 若 iframe 被 CSP 挡住，退路是：**插件只放一个"打开看板"按钮**（`openExternal`），
   仍然是薄框，仍然不重写看板。

## 设计约束（不许违反）

1. **不重写看板** —— 插件的全部内容就是一个 iframe；任何"顺手实现一点"都会变成第二份实现；
2. **不新增宿主能力** —— 不注册模型工具、不申请网络/写权限；
3. **主仓不受影响** —— `plugin/node_modules` 与 `plugin/lib/client.js` 都不入库；
   `scripts/selfcheck.mjs` 不依赖本目录（已验证：插件存在时自检仍 59/59）。

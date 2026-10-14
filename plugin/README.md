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

## 安装格式（已由真实报错修正）

第一次安装被拒，报错给出了确切要求：

```
Cannot validate installed package: dsh.bundle.patch must be a file path or a list of file paths
```

我原先的 `dsh.bundle` 写成对象（错的）。**已照本机已装插件 `dsh-context` 的真实结构修正**：

```jsonc
"exports": { "./client": "./lib/client.js" },      // 直接给路径字符串
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },     // 指向补丁文件
  "client": { "inject": ["@deepseek-ai/dsh-client-ui-conversation",
                         "@deepseek-ai/dsh-client-ui-layout"], "platform": "web" },
  "compatibility": { "dshReleases": { "0.1.5-rc.2": "compatible", "0.2.0-rc.2": "compatible" } }
}
```

配套的 `cordis.patch.yml`（照 `dsh-context` 的格式）：

```yaml
- insert:
    - id: dsh-plugin-devflow
      name: dsh-plugin-devflow
```

## 已做的本地验证

| 项 | 结果 |
|---|---|
| 宿主入口 `lib/index.js` | ✅ `default` 是函数，模拟 cordis 调用**无异常** |
| 客户端产物 `lib/client.js` | ✅ 80 KB、合法 ESM、含 `export default` |
| 注册调用确实在产物里 | ✅ 含 `sidebarRightTabs` 与 `slots.inject` |
| 客户端产物体积 | ✅ **2.7 KB**（React 走宿主 `require`，**不内联**） |
| 产物格式 | ✅ `window.__ModuleLoader__.load({ id, factory })`，无顶层 `export` |
| 模拟宿主加载 | ✅ factory 返回 `{name, inject, apply}`，`apply` 正确注册标签页类型与内容 |

## ⚠️ 尚未验证的边界（如实登记）

| # | 未验证项 | 影响 |
|---|---|---|
| 1 | ~~`bundle` 格式~~ | ✅ **已修正**（见上，来自真实报错 + 本机已装插件对照） |
| 2 | **端到端加载** | ⚠️ 有待你重启验证。**已修掉上一次导致 boot 失败的原因**（见下），并已做宿主加载器模拟 |
| 3 | **iframe 是否被 CSP 允许** | DSH 界面里有 `iframe` 用法，机制可用；**是否允许指向 `http://127.0.0.1:8787` 未验证** |
| 4 | ~~标签页如何被打开~~ | ✅ **已修**：必须在 `sidebarRightTabs.register({...})` 里带 **`guide: [{ order, title(), description() }]`** 才会在侧栏 guide 里出现按钮。第一次漏了它 ⇒ **界面什么都没有**（实测）。形状照 `dsh-context` 的真实调用 |

## 环境的两个限制（这就是我无法替你验证的原因）

| 限制 | 后果 |
|---|---|
| **`desktop` profile 被 Electron 应用独占管理** | CLI 不能往里装（`error: profile "desktop" is managed exclusively by the Electron application`）。而你正在用的 GUI 就是 desktop ⇒ **要走 GUI 的「添加插件」** |
| **`dsh plugin add` 需要 pnpm** | 当前 PATH 上没有 pnpm（GUI 内部自带，所以**GUI 安装可以，命令行不行**）|

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

## 分发注意事项（发布前必读）

当前安装方式是 **`link:`（本地软链）**，所以本地构建出的 `lib/client.js` 会被直接用上。

**若将来要发布成 npm 包，必须改掉这一点** —— 因为 `lib/client.js` 目前被 `.gitignore` 排除
（它是构建产物），直接 `npm publish` 会**缺少客户端半边**，装出来的插件不会显示任何界面。
届时二选一：

| 做法 | 说明 |
|---|---|
| **把 `lib/client.js` 入库** | 最简单；但每次改源码要重新构建并提交产物 |
| **加 `prepublishOnly` 构建** | 发布前自动构建；需要在 `devDependencies` 里保留 esbuild |

另外 `dsh.compatibility.dshReleases` 目前只声明了两个版本
（`0.1.5-rc.2` 与本机 GUI 用的 `0.2.0-rc.2`）。**DSH 升级后要补这一项**，
否则会被判为不兼容而拒绝加载（本机 `dsh-better-sidebar`、`dshmarket` 就是这么被拦下的）。

## 踩过的坑：客户端产物格式（第一次 boot 失败）

第一次装完后启动失败：

```
web boot: 1 entry did not activate
dsh-plugin-devflow: import failed
renderer console: Uncaught SyntaxError: Unexpected token 'export'
```

**原因**：我把产物打成了 ESM（`export default plugin`），而宿主是用**普通 `<script>`**
加载 `client.js` 的（路径 `dsh-app://app/plugins/??<name>/client.js`）—— **不支持顶层 ESM**。

**修正**（照 `dsh-context` 的真实 `lib/client.js` 对齐，三处）：

| # | 错误 | 正确做法 |
|---|---|---|
| 1 | `export default plugin` | 包成 `window.__ModuleLoader__.load({ id, factory: (require) => {…} })` |
| 2 | 导出**函数** | 导出**对象** `{ name, inject, apply }` |
| 3 | 把 React 打进产物 | React 由宿主 `require("react")` 注入 —— 内联会出现**两份 React** |

修正后产物 **80 KB → 2.7 KB**。

## 踩过的坑之二：注册了标签页却"什么都没有看到"

第二次启动不再崩，但界面上**什么都看不到**。原因：

`sidebarRightTabs.register()` 只注册了**类型**，**不产生任何入口**。
入口要另外声明在同一个调用的 **`guide` 数组**里：

```js
ctx.sidebarRightTabs.register({
  id, kind,
  title: () => 'devflow 看板',
  guide: [{ order: 30, title: () => 'devflow 看板', description: () => '…' }],  // ← 这个才渲染成按钮
});
```

* **guide 条目** = 侧栏 guide 里的按钮（用户从这里打开页面型标签）；
* 没有 guide ⇒ 类型存在但**用户永远看不到**（与"静默失效"同类）。

形状照 `dsh-context` 的真实调用核对：`{ order, title(), description(), icon? }`
（**不需要** `id`/`kind` —— 与官方 README 的措辞不完全一致，以真实源码为准）。

## 踩过的坑之三：要求用户自己起服务（已修）

第一版只做客户端 iframe，要求用户**自己到项目目录执行 `devflow board`**。用户反馈：
> 不会在点击的时候主动运行吗？每次都需要在项目目录里执行吗？

**这是把本可自动化的事推给人**，而且不执行就看到一片空白（无提示）。已修两处：

| # | 修法 |
|---|---|
| 1 | **宿主半边自动起服务**：`src/index.js` 在插件激活时先探测 `8787`，未就绪才用 `ctx.shell.execute(ctx.shell.resolve({ command, onExpiry: 'none' }))` 起一个**常驻**的 `devflow board`；起不来**不抛异常**（面板会显示原因，而抛异常会连累整个 web boot） |
| 2 | **看板自己向上找根**：`discoverProjectRoot()` 从 cwd 逐级向上找 `.devflow/`、`devflow.json`、`devflow.workspace.json`。这样插件从任意目录启动都能找到用户的工作区 —— 不让插件去猜（它会猜成插件自己的目录，实测踩到） |

**仍然保留的边界**：插件只在**服务未就绪**时启动，不会重复起第二个（避免端口冲突）。

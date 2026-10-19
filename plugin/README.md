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

## 踩过的坑之四：sandbox 缺 `allow-same-origin` ⇒ 看板一片空白（已修）

**症状**：右侧面板能打开，看板标题与顶栏都在，但指示灯是红的「已断开，重连中…」，
**统计卡与任务卡整片没有**；而且**一句提示都没有**（面板以为服务好着呢）。

**根因链**（四步，缺一不可）：

| # | 环节 |
|---|---|
| 1 | `src/client.js` 的 sandbox 只有 `allow-scripts allow-popups allow-forms`；不给 `allow-same-origin` ⇒ 内嵌文档的源是 **opaque 的 `null`** |
| 2 | 看板的数据**全部**走 SSE：`scripts/lib/board.mjs` 里 `new EventSource('/api/stream')`，HTML 壳里的 `#stats`/`#lanes` 是空的，**只有 `es.onmessage` 才会填** |
| 3 | SSE 响应没写任何 CORS 头 ⇒ `null` 源的跨源请求被浏览器拒掉 |
| 4 | `es.onerror` 触发 ⇒ 头部变「已断开，重连中…」，数据永远不来 |

浏览器原话（挂到子 frame 会话才抓得到）：

```
Access to resource at 'http://127.0.0.1:8787/api/stream' from origin 'null'
has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present
on the requested resource.
```

**为什么一直没人发现**：

* 宿主诊断日志（`~/.dsh/devflow-board.log`）只记宿主半边，**故障发生在浏览器里** ⇒ 日志看着一切正常，面板却是坏的；
* 面板原来的探测用 `fetch(..., { mode: 'no-cors' })`：CORS 被拦也算"连得上"（拿到 opaque 响应）⇒ 永远报 `ok` ⇒ 连「看板服务没有在运行」那句提示都不会显示。

**修法（两处，必须配套）**：

| # | 修法 |
|---|---|
| 1 | iframe 的 sandbox 补上 `allow-same-origin`。**安全性不变**：看板页来自 `http://127.0.0.1:<port>`，与 DSH 界面依旧是**跨源**，拿不到 DSH 的 DOM/storage；父页不同源时内嵌页也无法自行摘掉 sandbox |
| 2 | 看板页用 `postMessage({ source:'devflow-board', status })` 把 SSE 的真实状态报给面板（`onopen`→`open`，`onerror`→`error`）；面板据此新增 `blocked` 态，明说「数据流被浏览器拦掉了」而不是继续装死 |

### 追记（2026-10-19）：真正的第一现场是 `localStorage`，不是 SSE

后面复现时发现因果链还差一环，而且它在**更前面**：

浏览器在 sandbox 缺 `allow-same-origin` 时，连 `localStorage` 都不给：

```
Failed to read the 'localStorage' property from 'Window':
  The document is sandboxed and lacks the 'allow-same-origin' flag.
```

而看板脚本**第一行**就是 `let ROOT = localStorage.getItem('devflow.root')` —— 这一句抛
`SecurityError`，**整段 JS 直接不执行**：SSE 根本不会创建、`onerror` 不会绑定、
连"已断开"都不会显示，页面永远停在静态的"连接中…"。

也就是说：**只修 CORS 是没用的**，脚本在更早的地方就死了。

因此看板页另加了两道兜底（与宿主修法**互相独立**，任何嵌入方都受益）：

| 兜底 | 作用 |
|---|---|
| `SAFE_STORAGE`（localStorage 包装，失败降级为内存 Map） | 沙箱里脚本也能跑完，后续逻辑（含错误处理）得以执行 |
| SSE 失败时的**页内红色横幅** | 直接写明"数据流没连上 + 最可能是 sandbox 缺 allow-same-origin + 两种解法 + 一条 DevTools 排查语句" |

验证方式（可复现）：同一地址分别放进两种 sandbox iframe ——
无 `allow-same-origin` 的那个现在会显示红色横幅（而不是一片空白），有它的那个正常渲染。

**复发时怎么快速定位**：把同一个看板地址分别放进 sandbox iframe 和普通 iframe —— 普通 iframe 正常、sandbox 里空白，就是这条。
`scripts/selfcheck.mjs` 的 SC60/SC61 覆盖了界面钩子与插件产物卫生，改完记得重跑。

## 宿主半边的两个致命 bug（已修，由诊断日志定位）

装上后服务起不来，日志（`~/.dsh/devflow-board.log`）一行就定位了：

```
激活：已在跑=false cwd=…/profiles/desktop 候选=（无有效候选）
启动失败：spec is not defined
```

| # | Bug | 机制 |
|---|---|---|
| A | `hasMarker` 在 **ESM 文件里用了 `require('node:fs')`** | ESM 没有 `require` ⇒ 抛错被 `catch` 吞掉 ⇒ **每个候选都判无效** ⇒ 不传 `--root` ⇒ 从宿主目录启动被拒 |
| B | `diag(spec.command)` 写在了 **`spec` 的作用域之外** | 抛 `spec is not defined`，**打断整个启动流程** |

**共同特征：静默失效。** A 被 catch 吞掉、B 只留下模糊的失败信息 ——
所以面板只能说"没有在运行"，而**真正原因必须靠日志才能看到**。

**教训（已固化为 SC61 自检）**：
* ESM 源码**不得出现 `require(`**；
* 构建产物**不得含 `/Users/` 或 `/home/` 路径**；
* 宿主半边必须是 `{name, inject, apply}`；
* 客户端产物必须是 `__ModuleLoader__` 格式。

## 已知限制：一个服务 = 一个工作区

看板服务的根在**启动时**确定（`--root` 或向上查找），`/api/state` **不接受 root 参数**。
所以换项目时要另起一个：

```bash
devflow board --port 8788 --root <另一个项目或工作区根>
```

**改进方向（数据层已就绪）**：`collectBoardState(root)` 与 `collectChange(root, id)`
本来就是**按 root 参数化**的，所以把根从"启动时确定"改成"**每请求确定**"
（`/api/state?root=…`、`/api/stream?root=…`）是小改动，之后就能：
* 一个服务服务任意工作区（不用多端口）；
* 面板里加工作区切换下拉（需要一份"已知工作区列表"，可来自 DSH 的 workspace API）。

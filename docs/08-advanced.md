# 进阶用法

> **这不是必经之路。** 先看 [操作指南](00-quickstart.md) 把一次变更跑通，再按需回来查这里。
>
> 本文件收录：可选增强（契约判定、看板/插件、多仓工作区、事件流）与完整命令表。

---

## 契约破坏性判定（只有跨边界变更需要）

改了对外约定（端点/字段/鉴权）时，**最危险的不是写错，而是漏掉"谁会被影响"**。这一步把它变成机械判定：

```bash
~/.devflow-kit/bin/devflow contract snapshot <变更>   # 冻结契约时存基线（**入库**，CI 要用）
~/.devflow-kit/bin/devflow contract diff <变更>       # 当前契约 vs 基线，逐条判定破坏性
~/.devflow-kit/bin/devflow contract rules             # 规则是数据，可审计、可讨论
```

**输出形如**：

```
⛔ BREAKING  endpoint-removed
    GET /api/orders
    为什么：既有消费方调用会得到 404
    怎么办：保留端点（可标记废弃）或提供替代端点的并行发版窗口
⚠ WARN  endpoint-owner-changed
    POST /api/orders/{no}/cancel：order-api → order-service
```

* `BREAKING` = 会让既有消费方中断 ⇒ 必须在「兼容策略」表里给出并行发版/多版本方案；
* `CI 用法`：`contract diff <变更> --fail-on-breaking` 有 BREAKING 时退出码 3；生成的 CI 默认只**报告**（`|| true`）。

**刻意不做**（写进了正典的 nonGoals）：
* 不判定**字段语义**变化（"同一字段含义变了"纯文本匹配判不出来）—— 那必须人工确认；
* 不替代运行时契约测试 —— 这是**静态结构比对**。

## 看板与聊天并排

**方式 A：浏览器窗口并排（零配置，推荐）**

```bash
devflow board          # 起一次，常驻
# 浏览器打开 http://127.0.0.1:8787，与 DSH 窗口并排
```
> **也可以在聊天里直接说「盯着看」** —— 我会把它作为受管后台任务起好并把地址给你，不用自己敲命令。

**方式 B：DSH 插件内嵌面板（可选，装了才有）**

`plugin/` 是一个 **DSH 薄框插件**：在 DSH 右栏内嵌同一块看板（iframe 指向 8787），
**只做窗口**，不含任何业务逻辑。**删掉它不影响任何工作流能力。**

| 项 | 说明 |
|---|---|
| 安装 | **`devflow setup --dsh`**（一条命令、不需要 pnpm）；也可在 DSH 里 «添加插件» 填 `plugin/` 路径 |
| 自动启动 | 插件激活时**自己把 `devflow board` 起起来**，你不用手动执行 |
| 失败排查 | 看 `~/.dsh/devflow-board.log`（宿主日志在 GUI 里看不到，所以写文件） |
| **工作区范围** | **一个服务对应一个工作区**（启动时确定）。**换项目要换工作区，见下节** |

## 档位：产物要求之外的"步数"也不同

四个档位不只是**产物多少**的区别，**状态推进的步数**也不同 —— 依据是正典
`spec/states.json` 的 `tiers[].skippableStates`：

| 档位 | 必需产物 | 确认点 | 可跳过的状态 | 最短路 |
|---|---|---|---|---|
| `micro` | 无 | 0 | spec_ready, contracted, implementing, tested, verified | **1 步**：`draft → released` |
| `light` | SPEC + coding_report + verification + APPROVALS + release | 1 | contracted | 5 步 |
| `standard` | light 的 + TASKS | 2 | contracted | 6 步 |
| `heavy` | standard 的 + CONTRACT | 3 | （无） | 7 步 |

**规则**：只有当**起点与终点之间的每一个状态都可跳过**时，才允许一步跨过去；
任一中间状态不可跳过 ⇒ **仍然拒绝**（状态机不会被绕过）。

```bash
devflow new --date 2026-10-14 --slug fix-copy --tier micro --title "改个文案" ...
devflow advance 2026-10-14-fix-copy --to released     # 一步到位，0 产物 0 签字
```

> 说明：这条规则以前**没生效** —— `skippableStates` 在正典里写了，但代码从不读它（死字段），
> 于是 micro 也要走 6 次推进。现已实现，并由 `examples/verify-tiers.sh` 双向断言守住
> （既断言"能一步跨"，也断言"不可跳时必须拦"）。

## 面板显示「没有在运行」/「未选择工作区」怎么办

**先分清两种提示**：

| 面板显示 | 含义 | 怎么办 |
|---|---|---|
| **未选择工作区** | 服务**起来了**，但没找到项目 ⇒ 呈现空看板 | 在右上角**选一个工作区**（下拉里是你登记过的项目）；若下拉为空，见下条 |
| **看板服务没有在运行** | 服务没起来（插件未能启动它） | 看 `~/.dsh/devflow-board.log` 的最后一行；或手动跑 `devflow board` |

**下拉里为什么会有你的项目**：`devflow init` 与 `devflow setup --project` 会把项目路径
**登记**到用户级清单（`~/.dsh/devflow-kit.json` 的 `knownProjects`），面板就是从这里读的。

**所以别人装完之后**，如果下拉是空的，只要在项目里跑一次：

```bash
cd <你的项目>
~/.devflow-kit/bin/devflow init --name <项目名>      # 首次接入（会登记）
# 或（已经 init 过的项目）：
~/.devflow-kit/bin/devflow setup --project           # 装钩子并登记
```

也可以用 `devflow board --root <路径>` 显式指定，或在面板输入框里直接**粘贴绝对路径**切换。

> **设计说明**：插件**不再需要猜**工作区 —— 早先靠"猜候选目录"，在别人的机器上必然猜不到
> （kit 在家目录、cwd 是宿主目录），于是服务直接起不来、面板永远是"未启动"。
> 现在改为：**服务无条件启动**（找不到根就进入"待选工作区"模式）+ **项目由用户登记**。

## 多个项目 / 换工作区

看板服务启动时会确定**一个根**（项目或工作区）：

| 情形 | 行为 |
|---|---|
| 单仓项目 | 根 = 该项目 |
| 多仓工作区 | 根 = 工作区根，看板显示**所有成员的变更**（按仓标注） |
| 从任意目录启动 | 自动**向上查找** `.devflow/`、`devflow.json`、`devflow.workspace.json` |
| 显式指定 | `devflow board --root <项目根或工作区根>` |

> ⚠️ **当前是"一个服务一个工作区"**：换项目要看另一个工作区，需要**换一个端口再起一个**
> （`devflow board --port 8788 --root <另一个根>`），或在面板里切换（见 `plugin/README.md` 的已知限制）。
> 这是已知设计限制，不是 bug。

## 看板命令（`devflow board`）

```bash
~/.devflow-kit/bin/devflow board [--port 8787]
# → 浏览器打开 http://127.0.0.1:8787
```

看板内容：
* **指标卡**：在办变更 / 任务总数 / 进行中 / 已完成 / 阻塞；
* **按状态分栏**：待开始 · 进行中 · 已完成 · 阻塞（卡片显示负责人与⛔阻塞原因）；
* **按阶段分栏**：草稿 → … → 已发布，每个需求落在哪一格一目了然；
* **点任务卡 → 右侧抽屉**：字段详情 + **前世今生**（该任务的全部事件，含谁在何时改的）；
* **实时**：改动磁盘上的状态后 2 秒内自动刷新（SSE）。

**安全边界（v1 故意收紧）**：只监听 `127.0.0.1`、**只读**（要改状态请在 CLI 或聊天里操作）、无鉴权。
> 因为只读 + 仅本机，才不需要鉴权；**一旦要加写操作，必须同时加鉴权**。

## 事件的前世今生（tasks 的事件流）

```bash
~/.devflow-kit/bin/devflow history <变更>              # 全部事件
~/.devflow-kit/bin/devflow history <变更> --task T-2   # 只看某个任务
```

事件在 `advance` / `task` / `clarify` / `gate run` 时自动记录，回答"谁在何时把 T-2 标成阻塞、卡了多久"。

**`graph` 的三种图**（Mermaid 文本，GitHub/GitLab 原生渲染，也可贴进任何支持 Mermaid 的地方）：

| 命令 | 画什么 | 用途 |
|---|---|---|
| `graph --kind tasks` | **任务依赖图**：节点=任务，连线=依赖，颜色=状态（含阻塞原因与负责人） | 一眼看出"哪个任务卡住、卡在谁" |
| `graph --kind flow` | **需求流转图**：每个需求处于哪个节点 | 回答"每个需求走到哪了" |
| `graph --kind stages` | 工作流状态机（含各状态把门的门禁） | 放进文档/培训材料 |
| `graph --kind all` | 全部变更的任务图 | 总览 |

> 把 `graph` 的输出**粘进合并请求**，评审者不装任何工具就能看到依赖与阻塞情况。

`view` 生成的文件可以**直接在浏览器打开、发给别人、附在合并请求里**，里面：
* 每个**阶段芯片可点开** → 看该阶段要求哪些产物、你满足没有、由哪个门禁把关；
* 每个**任务可点开** → 看验收标准原文、验收命令、依赖链、负责人；
* **产物文件名可点开看全文**；
* 点阶段芯片会**同时把下方任务列表过滤到该阶段**。

```bash
~/.devflow-kit/bin/devflow status <变更> --digest    # 一行摘要，适合贴进对话
~/.devflow-kit/bin/devflow task <变更> T-2 --status 阻塞 --note "等接口联调"   # 任务级干预
```

> 标记**阻塞必须给原因** —— 没有原因的阻塞无法被处理。

---

## 在聊天里说人话

完整话术对照表在 [操作指南 · 在聊天里只要说一句话](00-quickstart.md#在聊天里只要说一句话)。

**核心原则**：命令是给 CI 与自动化用的；人应该说人话。若模型只回你一条命令，那是它没做对。

---

## 附：全部命令一览

**你不需要记这些** —— 在聊天里说人话就行。这张表是给"想精确控制"和排查问题用的。

| 命令 | 用途 | 常用度 |
|---|---|---|
| `init --name <名>` | 接入项目（写 `devflow.json` 与门禁脚本骨架） | 每仓一次 |
| `setup [--global\|--project]` | 装钩子（每仓）/ 装聊天技能（一次） | 每仓一次 |
| `doctor` | 体检：门禁是否可信、配置是否可用（只读，给修法） | 常查 |
| `standards` | 逐条判定基础标准（含如何自定义/覆盖） | 偶查 |
| `architecture` | 生成仓级架构声明（技术栈/分层/ADR/约束） | 每仓一次 |
| `new --date --slug --tier --title` | 新建变更 | 每变更一次 |
| `clarify <变更> [--answer\|--pending]` | 需求澄清（必答项；未决不许进实现） | 每变更一次 |
| `contract snapshot\|diff\|rules` | 契约冻结与破坏性判定 | 跨边界变更 |
| `review <变更> [--point]` / `review --all` | 人工确认点的决策材料与签核 | 每变更 1–3 次 |
| `fill <变更> --to <状态>` | 按模板补齐缺失产物（不覆盖已有） | 按需 |
| `gate run <变更> [--check]` | 跑门禁并留证据（`--check` 只预检） | 频繁 |
| `advance <变更> --to <状态>` | 推进状态（缺件/不合规会被拒） | 频繁 |
| `task <变更> <T编号> --status/--owner/--note` | 任务级干预（阻塞必须给原因） | 按需 |
| `history <变更> [--task T-2]` | 任务的"前世今生"（谁在何时改了什么） | 偶查 |
| `start` | 你在哪、有哪些变更、下一步是谁的动作 | 常查 |
| `status <变更> [--digest]` | 单变更状态（`--digest` 出固定摘要） | 常查 |
| `doc <变更> [文档]` | 在终端读阶段文档（不带文档名则列出清单；`--raw` 出原文） | 常查 |
| `view`（别名 `report`） | 生成可点击的单文件 HTML 视图（含图形） | 常查 |
| `board [--port]` | 启动本地实时看板（只读，SSE 刷新） | 按需 |
| `graph [--kind tasks\|flow\|stages]` | 输出 Mermaid 图（可贴进 PR） | 按需 |
| `ci --platform <github\|gitlab>` | 生成 CI 配置（kit 自动从 GitHub 取） | 每仓一次 |
| `workspace init\|add\|remove` | 多仓工作区（跨仓协作时用） | 多仓时一次 |
| `archive [--go]` | 归档已完成变更（默认空跑） | 偶用 |
| `adapters [--apply <栈>]` | 列出/检测技术栈适配器；`--apply` 只补缺失 | 接入/换栈 |
| `migrate-storage` | 迁移旧版产物存储布局 | 老项目一次 |
| `selfcheck` | 门禁体系自检（71 项，全绿才算通过） | 开发/升级后 |
| `skill [sync] [--check]` | 把已装的聊天技能副本与 kit 源文件对齐（正常会自动收敛，一般不必手跑） | 排查用 |
| `version` | 版本与 kit 位置 | 排查用 |

> `report` 是 `view` 的历史别名（两者等价）；新写的脚本请用 `view`。


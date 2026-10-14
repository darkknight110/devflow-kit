# 操作指南（从零到跑完一次变更）

> 这份文档回答一个问题：**我拿到 devflow 之后，具体怎么操作？**
>
> 按顺序做一遍即可。全部命令都在**真实场景验证过**（含 Linux CI 双平台）。
> 需要查规则细节时，再看对应的参考文档（每节末尾有链接）。

---

## 第 0 步：拿到它（约 1 分钟）

```bash
# 三选一
git clone https://github.com/darkknight110/devflow-kit.git ~/.devflow-kit   # ① 克隆（推荐）
npm install -g devflow-kit                                                   # ② 全局安装
npx devflow-kit --help                                                       # ③ 临时用一次
```

**零依赖**：只用 Node 内置模块（Node ≥18），不需要 `npm install`、不需要构建。

> 用 ② 或 ③ 时，把下文所有 `~/.devflow-kit/bin/devflow` 换成 `devflow`。

---

## 第 1 步：在你自己的项目里装环境（约 1 分钟）

```bash
cd <你的项目>
~/.devflow-kit/bin/devflow setup
```

它会做三件事：
1. 装 **git 提交钩子**（拦下不合规的提交信息）；
2. 装 **DSH 聊天技能**（软链到 `~/.dsh/skills/devflow`）；
3. 记录 **kit 位置**（写 `~/.dsh/devflow.json`，供技能定位 CLI）。

> ⚠️ `.git/hooks/` 与 `~/.dsh/skills/` **都不在版本控制里** —— 每台新机器、每次重新 clone 都要跑一次 `setup`。

### 一次装，还是每个项目都装？（作用域）

**这是最容易搞混的地方**。devflow 有两类安装动作，作用域完全不同：

| 动作 | 作用域 | 装几次 | 命令 |
|---|---|---|---|
| **DSH 聊天技能**（`~/.dsh/skills/devflow`） | **用户级** | **一次**，跨所有项目生效 | `devflow setup --global` |
| **kit 位置记录**（`~/.dsh/devflow.json`） | **用户级** | 一次 | 同上 |
| **git 提交钩子**（`.git/hooks/commit-msg`） | **每个 git 仓** | 每个仓一次 | 在项目里 `devflow setup --project` |
| **项目接入**（`devflow.json` / 门禁脚本） | **每个仓** | 每个仓一次 | 在项目里 `devflow init` |

```bash
# 只做一次（跨所有项目）
~/.devflow-kit/bin/devflow setup --global

# 每个新项目各做一次
cd <项目> && ~/.devflow-kit/bin/devflow init --name <项目名>   # 接入
            ~/.devflow-kit/bin/devflow setup --project          # 装钩子
```

> 不带参数跑 `devflow setup` = 两类都做（幂等，重复跑不会出错）。
> ⚠️ **钩子与接入是逐仓的**：换机器或重新 clone 后，钩子必然缺失，需重跑 `setup --project`。

### skill 是全局的，那"工作区"是什么？

两者解决**不同的问题**，不重叠：

| | 作用 |
|---|---|
| **全局 skill** | 让你在**任何**目录下都能用聊天驱动工作流 —— 解决"能不能用" |
| **仓库接入（init）** | 让**这个仓**有门禁与产物规范 —— 解决"这个仓能不能被工作流管" |
| **工作区（workspace）** | 把**多个仓**纳入同一个工作流视野 —— 解决"跨仓协作" |

**为什么需要工作区**：一次变更可能同时改前端、后端、数据库（三个仓）。
工作区把它们的进展放在一个视图里，并支撑两件单仓做不到的事：

1. **按责任层分派跨仓任务**（TASKS 表的「目标仓」+「负责层」）；
2. **跨仓契约扫描**（前端调的端点在不在后端 —— 这是唯一不依赖运行环境的机械检查）。

```bash
cd <工作区根> && devflow workspace init          # 扫描一级子目录里的 git 仓
devflow workspace                                # 看各仓状态
devflow workspace add <仓> / remove <仓>          # 维护成员
```

**单仓项目不需要工作区** —— 直接用 `devflow start` 即可（`start` 会提示这一点）。

### DSH 与工作流是怎么连上的

```
你（在聊天里说人话）
   ↓
DSH 发现技能 ~/.dsh/skills/devflow → 加载其中的 SKILL.md（模型读的协议）
   ↓
模型按协议里的「人话 → 环节映射表」决定该做什么
   ↓
模型执行 kit 里的 CLI（devflow start / new / clarify / gate run / view …）
   ↓
CLI 读写你项目里的 .devflow/ 产物，并把机械结论（门禁/标准/契约）返回给模型
   ↓
模型用人话把结果告诉你；需要你决策时用选择框问你
```

**三个要点**：
* **技能只是一份协议**（`SKILL.md`），不含逻辑 —— 单一事实源仍是 CLI 与 `spec/*.json`；
* 技能**从自身位置推断 kit 路径**（`skill/` 的上一级就是 kit），所以装在 `~/.devflow-kit` 或任何位置都能工作；也可用 `export DEVFLOW=<kit>/bin/devflow` 显式指定；
* **聊天里不需要敲命令** —— 命令行方式仍完全可用，两者是同一套底层。

---

## 第 2 步：接入这个项目（约 1 分钟）

```bash
~/.devflow-kit/bin/devflow init --name <项目名>
```

* 自动识别技术栈（`pom.xml` / `package.json` / `pyproject.toml` / `go.mod`）；
* 生成 `devflow.json`（门禁声明）与 `scripts/` 下的门禁脚本骨架；
* **`devflow.json` 要入库**（团队共享、CI 也依赖它）。

**⚠️ 顺序很重要**：`init` 生成的 `scripts/build.sh`、`scripts/test.sh` 是**占位脚本**
（带 `devflow:placeholder` 标记）。**先把它们换成你项目真实的命令，再跑体检** ——
否则 `doctor` 会（正确地）判为**阻断**：`D4 门禁仍是 init 生成的占位脚本（该门禁现在必然失败）`。

```bash
# 换成真实命令（这一步不能省）
cat > scripts/test.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exec npx vitest run        # ← 换成你项目真实的测试命令
EOF
chmod +x scripts/test.sh

~/.devflow-kit/bin/devflow doctor      # 体检：门禁是否可信
```

**看到什么算好**：
* `结论：门禁配置健康：可以开工` —— 最好；
* `结论：门禁可用，但有 N 项强度被削弱` —— **可以接受**（多半是"缺负向对照"这类债务，属已知项，会如实显示为 ⚠ 而不是 ✓）；
* `结论：门禁**不可信**` —— **必须处理**，按它给的修法逐条改。

> 门禁的"削弱/不可信"不是让你放宽断言，而是**把债务摆到明面上**。
> 想清零削弱项：给每个门禁补一个"必然失败"的负向对照脚本（见 `docs/01-workflow-spec.md`）。

---

## 第 3 步：定一次项目架构（约 5 分钟，一次即可）

```bash
~/.devflow-kit/bin/devflow architecture
```

生成 `.devflow/architecture.md`，填四件事：
1. **技术栈**（各层用什么、什么版本）；
2. **分层与目录约定**（哪个目录放什么、禁止放什么）；
3. **架构决策（ADR）**：一条决策一行；
4. **不可违反的约束** + **项目自定义的必答问题**（第 4 步会用到）。

**为什么只做一次**：之后每个变更都继承这些约定，不用每次重写。**这个文件要入库**。

---

## 第 4 步：提需求 —— 先澄清，再落 SPEC（约 10 分钟）

### 4.1 建变更

```bash
~/.devflow-kit/bin/devflow new --date 2026-10-14 --slug coupon-remind \
  --tier standard --title "优惠券过期提醒" --owner 张三 --repos <仓名> \
  --surface ui --surface data
```

| 档位 | 什么时候用 |
|---|---|
| `micro` | 改文案、调常量 |
| `light` | 单仓单层、无接口变化 |
| `standard` | 跨模块或涉及数据/权限 |
| `heavy` | 改对外约定（端点/字段/鉴权）或跨仓 |

`--surface` 可重复传（或写成 `--surface ui,data`）。

### 4.2 澄清（**这一步最容易省，但最不该省**）

```bash
~/.devflow-kit/bin/devflow clarify <变更>
```

它会列出必答项（通用 6 条 + 你在 `architecture.md` 里追加的），逐条回答：

```bash
~/.devflow-kit/bin/devflow clarify <变更> --answer U-1 --text "提前 3 天提醒"
~/.devflow-kit/bin/devflow clarify <变更> --pending U-6 --text "等产品确认验收口径"   # 答不上来就标未决
```

> 🔒 **存在未决项时，不允许推进到实现**。这是产品里最硬的一道闸 ——
> 质量损失的最大来源就是"没人问该问的问题"。

### 4.3 把答案写进 SPEC

打开 `.devflow/items/<变更>/SPEC.md`，填「验收标准」表：

| AC | 判据 | 判据类型 | 责任方 |
|---|---|---|---|
| AC-1 | `./scripts/test.sh` 退出码 0 且覆盖"提前 3 天命中" | 命令 | 后端 |
| AC-2 | 消息中心出现"即将过期"条目，点击进入详情 | 画面 | 前端 |

**判据类型**只允许：`命令`（有命令可跑）/ `画面`（有画面可看）/ `报告卡`（人工留痕）。
**写不出判据的标准，不允许进入实现。**

---

## 第 5 步：分派任务（约 5 分钟）

编辑 `.devflow/items/<变更>/TASKS.md`：

| T | 目标仓 | 负责层 | 写入范围 | 依赖 | 状态 | 负责人 | 验收命令 | 对应AC |
|---|---|---|---|---|---|---|---|---|
| T-1 | order-api | 数据库 | db/migrations/008.sql | 无 | 待开始 | 李四 | ./scripts/test.sh | AC-1 |
| T-2 | order-api | 后端 | src/services/coupon.ts | T-1 | 待开始 | 张三 | ./scripts/test.sh | AC-1 |
| T-3 | order-api | 前端 | src/pages/message | T-2 | 待开始 | 王五 | ./scripts/test.sh | AC-2 |

两条硬规则（引擎会检查，**不是靠自觉**）：
1. **写入范围相交的任务不能分给不同人**（否则会互相覆盖）；
2. **变更面必须被责任层覆盖**（声明了 `ui`、`data`，就必须有前端与数据库任务）。

```bash
~/.devflow-kit/bin/devflow doctor    # 会报「任务缺责任层」或「写入范围相交」
```

---

## 第 6 步：实现 → 提测 → 验证

```bash
~/.devflow-kit/bin/devflow advance <变更> --to implementing   # 进入实现
# …… 写代码 ……
~/.devflow-kit/bin/devflow advance <变更> --to tested         # 自动跑门禁
```

**推进被拒时不要绕过** —— 它会说明缺什么，按提示补齐后重跑：

```bash
~/.devflow-kit/bin/devflow gate run <变更> --to <目标状态> --check   # 只读预检，先看差什么
~/.devflow-kit/bin/devflow fill <变更> --to <目标状态>              # 按模板补齐缺失产物（不覆盖已有）
```

### 写验证记录

`.devflow/items/<变更>/verification.md` 必须**逐条覆盖 AC**，每条附证据：

| AC | 结论 | 证据 |
|---|---|---|
| AC-1 | 已通过 | `src/services/coupon.ts:41` 提前 3 天命中；`exit=0` |
| AC-2 | 已通过 | 截图 `src/pages/message/screenshot.png` |

> ⚠️ **只写"已通过"而没有证据会被拦下**（占位内容不算证据）。
> 未验证的项写进「未验证项」表 —— **未验证 ≠ 可以**。

---

## 第 5.5 步：契约破坏性判定（只有跨边界变更需要）

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

## 第 6.5 步：人工确认点（谁签字、签什么）

三个确认点由正典定义，**门禁会验签**（要求真实姓名 + 时间 + 结论）：

| 确认点 | 什么时候 | 谁签 |
|---|---|---|
| **需求与判据**（AP1） | SPEC 完成后、进入实现前 | 需求方 |
| **契约冻结**（AP2） | 涉及跨边界变更（standard/heavy） | 前后端负责人 |
| **发布批准**（AP3） | 发布前 | 业务方/负责人 |

```bash
~/.devflow-kit/bin/devflow review <变更>                  # 本变更需要哪些确认点、当前状态
~/.devflow-kit/bin/devflow review <变更> --point 需求与判据  # ★ 摊开决策材料
```

**这条命令解决的是"人凭什么签"**。它会给你：

1. **要判断的问题**（一句话）；
2. **判断标准**（逐条，例如"每条 AC 都要有可执行判据，不接受'体验良好'这种无法判定的说法"）；
3. **材料摘要**（逐条 AC 的判据与类型、未决澄清数、端点数、验证条目…原文你随时可看）；
4. **能不能签的硬结论** —— 材料不全时**明确列出缺什么**，并**拒绝记录「通过」**。

看完材料、你真的同意了，才记录：

```bash
~/.devflow-kit/bin/devflow review <变更> --point 需求与判据 \
  --by 张三 --verdict 通过 --note "判据可执行，边界清楚"
```

### 签字会"过期"（这是刻意的）

`APPROVALS.md` 里有一列**内容指纹**：签字时把所批准材料的哈希一起写进去。
之后如果有人**改了已批准的内容**，指纹不匹配 ⇒ 该签字**判定失效**，等同未签：

```
确认点：需求与判据　⏸ 签字已失效（记录：李四 / 通过）
  ⏸ 失效原因：签字时的内容指纹 89d9a9d933d9 ≠ 当前 31623ff464cb（材料已被修改）
```

**为什么必须这样**：否则「签完字再改需求」无人察觉，确认点就只是个形式。
改动确实无关紧要时（例如仅格式调整），由确认人**重新签核**即可，指纹随之更新。

> 🔒 **agent 不得代填结论**：`--by` 必须是真人姓名。
> 材料不全时会被拒绝 —— 这是**防止"走个形式"**，而形式化的确认点是无效的质量闸。
> 确有已知并接受的风险时，用户明确同意后才用 `--force`（理由会记入事件流）。

## 第 7 步：发布

```bash
~/.devflow-kit/bin/devflow fill <变更> --to released     # 生成发布报告模板
# 填「发布内容 / 验证证据 / 观察窗口」，然后：
~/.devflow-kit/bin/devflow advance <变更> --to released
```

**观察窗口必须回填结论**（指标 + 时长 + 结果），否则视为未完成。

---

## 第 8 步：接 CI（让门禁成为强制，约 2 分钟）

```bash
~/.devflow-kit/bin/devflow ci --platform github    # 或 --platform gitlab
```

生成两份 job：
* **必过**：门禁（有已入库的变更就校验它，否则跑本仓测试脚本）；
* **报告**：`review --all`（人工确认点状态）+ `doctor` 体检 + 跨仓契约扫描
  （默认不阻断 —— 配置债务与"人还没签字"都不该让每次推送就红灯）。

> **为什么"人工确认点"只报告不阻断**：如果把"人还没签"变成红灯，团队会去关掉这个检查 ——
> 那比没有检查更糟。它应当**如实报告**（谁还没签），由人决定何时签。
> 真正的强制在门禁层：**没有签核就不许推进状态**。

接完提交即可。**CI 会自动从 GitHub 取 kit**，无需你额外配置。
多仓契约扫描需要后端仓，用 `--backend <仓名>` 生成。

---

## 日常：怎么看当前状态

```bash
~/.devflow-kit/bin/devflow start      # 你在哪、有哪些变更、下一步是谁的动作
~/.devflow-kit/bin/devflow view       # 生成可点击的单文件 HTML 视图（含图形）
~/.devflow-kit/bin/devflow graph      # 输出 Mermaid 图（可贴进 PR / 文档）
~/.devflow-kit/bin/devflow board      # 启动本地看板（实时，浏览器打开）
~/.devflow-kit/bin/devflow history <变更>   # 事件的"前世今生"（谁在何时改了什么）
```

### 在聊天里只要说一句话

**你不需要记这些命令**。装了技能之后直接说：

| 你说 | 你会得到 |
|---|---|
| "看看进度" / "给我个视图" | **界面上直接出现可点开的视图**（模型用 `present` 交给你，而不是甩一条命令） |
| "盯着看" / "实时看" | **看板就地启动**，并给你可点击的 `http://127.0.0.1:8787` |
| "现在到哪了" | 一行状态 + 下一步是谁的动作 |
| "这个需求我能批了吗" | 决策材料 + 能不能签的结论 |

命令是给 **CI 与自动化**用的；人应该看到界面。若模型只回你一条命令，**那是它没做对**，
可以直接说"你直接给我看"。

### 看板（`devflow board`）

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

### 事件的"前世今生"

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

## 在聊天里操作（可选，但更省事）

装好 `setup` 后，在 DSH 聊天里**直接说人话**即可，不需要记命令：

| 你说 | 触发 |
|---|---|
| "我有个需求：优惠券快过期时提醒用户" | 走需求澄清 → 落 SPEC |
| "这个怎么分" | 按责任层拆任务 |
| "开始写吧" | 进入实现 |
| "现在到哪了" | 状态与下一步 |
| "看看进度" | 生成可点击视图 |
| "T-2 卡住了，等接口" | 任务级干预（标阻塞 + 原因） |
| "能发了吗" | 跑门禁 → 逐条核对 → 发布报告 |

---

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| `doctor` 报"门禁不可信" | 按它给的修法处理；`devflow standards` 看是哪条标准未满足 |
| 推进被拒但没说清原因 | 用 `--check` 预检（只读），它会列出缺什么 |
| 提示"占位内容不算证据" | 模板里的 `（…）`/`通过 / 驳回` 必须填成真实内容 |
| 提示"需求澄清仍有未决项" | 逐条 `clarify --answer` 或 `--pending`；未决项不允许进实现 |
| 提示"任务未覆盖应有责任层" | 给缺失的层补任务，或说明为何不需要独立任务 |
| `setup` 说"不是 git 仓库" | 在 git 仓库内运行；它仍会装聊天技能 |
| CI 里报 `command not found` | 装的是旧版生成的配置，重新跑 `devflow ci` 生成 |
| 换机器后钩子失效 | `.git/hooks` 不入库，重新跑 `devflow setup` |

---

## 参考文档（需要细节时再看）

| 文档 | 回答 |
|---|---|
| [`01-workflow-spec.md`](01-workflow-spec.md) | 工作流正典（状态机 / 门禁 / 角色 / 不变量） |
| [`02-adoption-guide.md`](02-adoption-guide.md) | 接入指南（含存量项目与排障） |
| [`03-daily-workflow.md`](03-daily-workflow.md) | 日常操作手册（一圈怎么跑、卡住怎么办） |
| [`04-standards.md`](04-standards.md) | 基础标准与自定义规则（要求是什么、怎么改） |
| [`05-storage.md`](05-storage.md) | 产物存放规则（放哪、是否入库） |
| [`07-ci.md`](07-ci.md) | 接入 CI 的细节与分工 |
| [`06-pilot-report.md`](06-pilot-report.md) | 真实试点数据（效率与质量的实测代价） |

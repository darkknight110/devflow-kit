# 接入指南

面向第一次使用 devflow-kit 的人与团队。目标是**十分钟内走完第一次接入**，且不需要阅读超出本指南的任何文档。

---

## 一、十分钟路径

### 1. 取得工具包

把 `devflow-kit/` 放在任意位置（它是独立产品，与项目无关）。确认可用：

```bash
./bin/devflow version
```

### 2. 初始化项目

在**项目根目录**执行：

```bash
<kit>/bin/devflow init --name my-project --kind service
# 技术栈通常不用指定：init 会看 pom.xml / package.json / pyproject.toml / go.mod 自动识别。
# 要显式指定就用下面这四个 id（写错会直接报错退出，不会静默接受）：
#   java-maven | node-jest | python-pytest | go-test
```

会创建（**已有文件一律不覆盖**）：

| 文件 | 作用 |
|---|---|
| `devflow.json` | 项目适配契约：声明门禁命令、规模档、预算 |
| `.devflow/items/` | 变更目录（一个需求 = 一个目录） |
| `scripts/*.sh` | 门禁脚本 + 两个负向对照脚本。**识别出技术栈时会直接落该栈的真实命令**（例如 `mvn -B -ntp test`），没识别到则留占位脚本（含哨兵、刻意失败） |
| [`devflow.json`] `gates` | 默认只有两个门禁：`build` 与 `test`（需要契约门禁时自行加 `contract`） |

### 3. 选技术栈（已内置适配器，通常不用手写）

`init` 会按标记文件**自动识别**技术栈，并用该栈的真实脚本模板替换占位脚本：

| 技术栈 | id | 标记文件 | 测试计数形如 |
|---|---|---|---|
| Java · Maven | `java-maven` | `pom.xml` | `Tests run: 12, Failures: 0` |
| Node · Jest/Vitest | `node-jest` | `package.json` | `Tests:       12 passed` |
| Python · pytest | `python-pytest` | `pyproject.toml` / `setup.py` / `tests` | `12 passed in 0.42s` |
| Go · go test | `go-test` | `go.mod` | `12 tests passed`（由模板汇总） |

```bash
devflow adapters                          # 看有哪些栈、判断当前目录是哪个
devflow init --stack java-maven           # 显式指定
devflow adapters --apply go-test          # 已有项目补适配（只补缺失，绝不覆盖）
devflow adapters --apply go-test --demo    # 用自包含演示脚本（不装 Maven/pytest/Go 也能验证链路）
```

**两条重要行为**：

1. **只替换"占位脚本"和"默认声明"**：带哨兵 `devflow:placeholder` 的脚本可以被适配器替换；你自己写过的脚本、以及你自己声明过的门禁**永不覆盖**。要替换已有占位脚本，`init` 会自动做，`adapters --apply` 需要显式加 `--replace-placeholders`。
2. **Go 的计数需要模板帮忙**：`go test` 原生输出不含测试条数，适配器提供的 `scripts/test.sh` 会用 `-v` 汇总出 `N tests passed`。

> 若自动识别错了，用 `--stack` 显式指定即可。

### 4. 把门禁换成你的真实命令

打开 `devflow.json`：

```jsonc
{
  "devflow": { "kit": "^1.0", "project": "my-project", "kind": "service", "stack": "java-maven" },
  "profile": "team",
  "gates": {
    "build": { "run": "./scripts/build.sh", "negative_control": "./scripts/build-should-fail.sh" },
    "test":  { "run": "./scripts/test.sh", "count_regex": "Tests run: (\\d+)", "require_min_tests": 1,
               "negative_control": "./scripts/test-should-fail.sh" }
  }
}
```

**关于测试计数（多测试类工程必读）**

Maven / Gradle / pytest 在**多模块或多测试类**时会逐类打印汇总行，Maven 最后还会再打印一行总计。
引擎的做法是**累加所有匹配**（不能只取第一行，否则总数会被算小 —— 真实试点里曾把 15 个测试记成 4 个）。

因此：**计数 ≥ 实际测试数**，是保守估计。写 `require_min_tests` 时按"实际测试数"写即可（例如 15），
不要按累加值去写。若想精确控制，可把 `count_regex` 改成只匹配总计行的形式（各框架不同，需自行确认）。

**两条契约（务必遵守）**：

1. `run` 命令**必须以自身退出码表达结论** —— 不要写成 `构建 | tail`，管道的退出码是 `tail` 的，会把失败判成成功；
2. `negative_control` 是**必定失败的命令** —— 它用来证明你的门禁不是恒真。保持它失败。
   若你暂时不提供，该门禁会记为 **⚠ 未验证通过**（不阻断，但绝不显示为 ✓）。

### 5. 新建第一个变更

```bash
<kit>/bin/devflow new --slug first-change --tier micro --title "改一句文案"
```

`micro` 档只留状态记录、不留文档 —— 适合验证链路是否通。

### 6. 先体检：确认门禁真的能信

```bash
<kit>/bin/devflow doctor
```

首次体检出现「不可信」是正常的，它就是在提醒你「还没配好」。**三种常见原因，按出现频率**：

| 看到什么 | 真因 | 修法 |
|---|---|---|
| `⛔ D3 测试门禁"通过"了，但实际没有任何测试在跑` | **本仓还没有任何测试**（新建项目最常见） | **先写至少一个测试**。这不是"改脚本"能解决的 |
| `⛔ D3 测试门禁的测试框架还没装`（退出码 127 或 `No module named`） | 测试框架没装（`pytest` / `go` / `mvn` / `npm` 不在 PATH） | 装框架；**装不了时**用 `--demo` 路径（见下） |
| `⛔ D3b 构建门禁的构建工具还没装` | 构建工具没装 | 同上 |
| `⛔ D4 门禁 xx 仍是 init 生成的占位脚本` | 没识别出技术栈，脚本还是占位（含哨兵 `devflow:placeholder`），它刻意返回非零 | 用 `devflow adapters` 看支持的栈，或 `init --stack <id>` 重跑 |
| `⚠ D2 缺少负向对照` | 没有"必定失败"的对照命令 | 补一个 `exit 1` 的脚本并声明为 negative_control |

> ⚠️ **`baseline_exempt`（基线豁免）只用于存量项目**（历史就没测试基座的那种）。
> **新项目请不要用它** —— 新项目该做的是写测试，而不是给自己开豁免。

#### 装不了测试/构建工具链时怎么办（`--demo` 路径）

有时你只想先把**流程**跑通（例如本机没装 Go / Maven）。适配器提供的演示脚本会输出该技术栈的真实文本形态，
让你不装工具也能验证整条链路：

```bash
# 情形 A：项目刚初始化、脚本还是占位 → init 时直接加 --demo
devflow init --name my-proj --stack go-test --demo

# 情形 B：脚本已由适配器生成（真实模板）→ 需要显式允许覆盖"适配器自己的脚本"
devflow adapters --apply go-test --demo --force-scripts

# 先看会改什么，不落盘
devflow adapters --apply go-test --demo --force-scripts --dry-run
```

**覆盖规则（重要）**：

| 参数 | 能覆盖什么 | 不能覆盖什么 |
|---|---|---|
| （默认） | 只补缺失的脚本与门禁声明 | 任何已存在的脚本 |
| `--replace-placeholders` | init 生成的**占位脚本**（含哨兵 `devflow:placeholder`） | 适配器脚本、用户脚本 |
| `--force-scripts` | **适配器自己生成的**脚本（含 `devflow:adapter` 标记）与占位脚本 | **用户自己写的脚本**（既无哨兵也无适配器标记） |

> 演示脚本只用于跑通流程，**它不检查代码**。用它跑完之后，请尽快换成你项目的真实命令。

改完再跑一次 `devflow doctor`，直到结论是**可以开工**。

> doctor 是只读的，不改任何东西。它回答一个问题：**现在这套门禁，能不能信？**

### 7. 建变更并跑门禁

```bash
<kit>/bin/devflow status          # 先列出在办变更，复制它的名字
<kit>/bin/devflow gate run 2026-10-13-first-change
```

> **变更名规则**：`new --slug <名>` 时只给小写字母/数字/短横线，引擎会自动加上日期前缀，
> 最终 item 名形如 **`<日期>-<变更名>`**（例：`2026-10-13-first-change`）。
> `gate run` / `advance` / `fill` 都要用这个完整名字。

期望看到：项目门禁逐条结果（含退出码与输出尾部）、Kit 门禁 G0..G7、以及结论 PASS / BLOCKED。

### 8. 看板

```bash
<kit>/bin/devflow report          # 生成 .devflow/board.html
```

浏览器打开即可。**看板是只读视图**：不选工作区、不改状态、不做审批。

**走完这 8 步且无需查阅其他文档 ⇒ 接入成功。**

---

## 二、常见任务速查

| 我想… | 命令 |
|---|---|
| 体检：门禁能不能信 | `devflow doctor` |
| 看某个命令怎么用 | `devflow help <命令>` 或 `devflow <命令> --help` |
| 只看计划不落盘 | `devflow new --slug x --tier light --plan` |
| 看某变更的状态 | `devflow status <item>` |
| 给我一段可直接贴进对话的摘要 | `devflow status <item> --digest` |
| 看全项目在办变更 | `devflow status --all` |
| 跨项目汇总 | `devflow workspace`（需 `devflow.workspace.json`） |
| 推进状态 | `devflow advance <item> --to <状态>` |
| 归档已完成变更 | `devflow archive`（默认空跑，确认后加 `--go`） |
| 验证门禁体系本身 | `devflow selfcheck` |
| 机器可读输出 | 任意命令加 `--json` |

**状态取值**：`draft` → `spec_ready` → `contracted` → `implementing` → `tested` → `verified` → `released`。
`light` / `micro` 档允许 `spec_ready` → `implementing` 直连（跳过契约）。

---

## 三、四档怎么选

| 档 | 什么时候用 | 确认点 |
|---|---|---|
| `micro` | 文案、样式、单文件改动 | 0 |
| `light` | 单端 UI 调整、纯前端新页面、无接口变化的内部重构 | 1（发布前） |
| `standard` | 单仓功能开发、内部接口变化 | 2（需求判据 + 发布） |
| `heavy` | 跨仓、改对外接口、动数据与鉴权 | 3（+ 契约冻结） |

**三条硬降档禁令**：碰接口字段/数据/鉴权 ⇒ 最低 `standard`；跨两仓 ⇒ 必须 `heavy`；有测试基座不得用 `micro` 逃避验证。

按团队规模选 `profile`：`solo` / `team` / `cross-team` / `contractor` / `learning` / `legacy`（存量接入）。

---

## 四、存量项目怎么接入

1. `profile` 设为 `legacy`；
2. 在门禁里登记 `baseline_exempt`，写清 **原因** 与 **清除条件**（`clear_when`）：

```jsonc
"test": {
  "run": "./scripts/test.sh",
  "require_min_tests": 1,
  "baseline_exempt": { "reason": "本仓历史无测试基座", "clear_when": "test_count > 0" }
}
```

3. 已有的历史变更记录只作为归档证据，**不得**被当成"已通过门禁的变更"；
4. 每完成一次变更消除一项豁免（**只减不增**）；清零后把 `profile` 升级为标准档。

---

## 五、多项目管理

在**工作区根**放一份清单：

```jsonc
// devflow.workspace.json
{
  "workspace": { "name": "acme-platform" },
  "kit": { "path": "../devflow-kit", "version": "^1.0" },
  "members": [
    { "name": "order-api", "path": "projects/order-api", "kind": "service",  "stack": "java-maven" },
    { "name": "web-pc",    "path": "projects/web-pc",    "kind": "frontend", "stack": "node-jest" }
  ]
}
```

然后 `devflow workspace` 汇总所有成员的当前变更与门禁状态。

**工作区/项目怎么定位**（三种方式，从强到弱）：

1. `DEVFLOW_ROOT=<路径>` 环境变量；
2. `--root <路径>` 参数；
3. 自动向上查找：**同时存在 `devflow.json` 与 `.devflow/` 目录**才算项目根（双标记，避免同名文件劫持）。

---

## 六、`gate run` 的两种判定口径（别被 draft 状态骗了）

`gate run` 默认**只按当前状态**判定。在 `draft` 状态下几乎什么都不要求，所以它会 PASS ——
这**不代表**你的占位内容能过后续阶段。

要看"能不能推进到某个状态"，加 `--to`：

```bash
devflow gate run <item> --to verified      # 按 verified 的要求判定（推荐）
devflow gate run <item>                     # 只按当前状态判定
```

`--to <状态>` 会做**内容层**校验，包括：

- 必需章节与表格列是否存在；
- 每个 AC 是否有判据与判据类型；
- 每条任务是否声明写入范围、验收命令、对应 AC（断环会拦）；
- 验证记录是否逐条覆盖了所有 AC；
- **模板占位是否已填实**（`（姓名）`、`通过 / 驳回`、`（一次测试…）` 这类都算未填）。

`devflow advance <item> --to <状态>` 内部**总是**按目标状态判定 —— 所以"预检"和"真推进"口径一致。

**验证留痕规则（会被门禁强制）**：

- 若 `verification.md` 里写了"独立复核/独立验证"，就必须**同时**写明**复核方 + 时间戳（或命令原始输出）**；
  只写一句"我复核过了"会被 **G1b 直接阻断**。
- 工程侧自测请用 `devflow advance <item> --to verified --by engineer` 留痕，并且**不要**使用"独立复核"措辞。
- 复核结论**由复核者本人写入**。工程侧不得先写"已由独立复核通过"再去拿结论 —— 试点里真实发生过这种顺序倒置，
  记录会因此失去可信度。

## 七、退出码语义（便于接 CI）

| 退出码 | 含义 |
|---|---|
| `0` | 成功（注意：`gate run` 在有 ⚠ 未验证通过、但无阻断时也是 0） |
| `1` | **被门禁阻断**（`gate run` / `doctor` / `selfcheck` 结论为不可用） |
| `2` | **用法或参数错误**（未知技术栈/档位/变更面/规模档、缺少必填参数、找不到项目根） |
| `3` | **找不到对象**（变更目录不存在、状态文件缺失） |
| `9` | 未预期的内部错误 |

在 CI 里最常用的是：`devflow gate run <item>` 退出码非 0 即视为未通过。

---

## 八、排障

| 症状 | 原因与处理 |
|---|---|
| `未找到项目根` | 项目根需要 `devflow.json`；建议同时有 `.devflow/`。可加 `--root` 或 `DEVFLOW_ROOT` |
| 提示"项目根仅凭 devflow.json 判定" | 缺少 `.devflow/` 目录：先跑一次 `init`，或确认没写错目录 |
| `doctor` 说"测试门禁通过了但没有测试在跑" | 本仓还没有测试。**先写一个测试**（新项目不要用 baseline_exempt 绕） |
| 门禁记 ⚠ 而不是 ✓ | 负向对照缺失或它返回了 0（说明门禁恒真）。补一个必定失败的对照脚本；`devflow doctor` 会告诉你缺哪一个 |
| doctor 说「门禁不可信」 | 按输出里的**修法**逐条处理。最常见是占位脚本没换（含哨兵 `devflow:placeholder`）或负向对照返回 0 |
| 门禁通过但我怀疑没检查东西 | 跑 `devflow doctor`：它会检查「退出码 0 但实际没有测试在跑」这类假通过 |
| 门禁 PASS 但命令其实失败了 | 检查命令是否用管道收尾（`... \| tail`）—— 管道退出码不是你的构建结论 |
| `拒绝推进：缺少产物 X` | 该产物属于目标状态的必备要求。补齐内容，或换一个更低的目标状态/档位 |
| `非法状态转移` | 状态只能按转移表前进；确需跳步用 `--force`（会留下绕过门禁的留痕） |
| `未知状态` 报错 | `STATE` 文件被写成了未定义的值。状态必须来自 `spec/states.json` 的全量枚举 |
| 测试数为 0 被判失败 | 这是刻意的：测试为 0 不许判绿。要么补测试，要么登记 `baseline_exempt` |
| 看板上点不了按钮 | 刻意设计：状态转移必须过门禁。干预请回到会话 |
| 变更体积超阻断线 | 拆分变更。阈值可在 `devflow.json` 的 `budget` 里调整 |

---

## 七、给"交付物"的约定（与宿主无关）

agent 的职责终点是产出**交付包**：分支 + 提交（显式路径）+ 变更摘要 + 合并请求草稿。
**推送、开合并请求、审阅、合并由人完成。**

```bash
git commit --only <显式路径>      # 禁止 git add -A
```

---

## 九、升级与兼容

- Kit 遵循语义化版本；`devflow.json` 里用 `devflow.kit` 声明约束（如 `^1.0`）；
- 版本不满足时 **G0 直接阻断并报错**，**不静默降级**；
- 破坏性变更提升主版本号，并在 `docs/01-workflow-spec.md` 给出迁移说明。

---

## 十、自检与验收（交付前必跑）

```bash
node <kit>/scripts/selfcheck.mjs        # 门禁体系自检：32/32
bash <kit>/examples/verify-example.sh   # Node 形态端到端（23 条断言）
bash <kit>/examples/verify-java-project.sh  # Java 形态端到端（17 条断言）
bash <kit>/examples/verify-stacks.sh    # 四栈交叉验收（25 条断言）
bash <kit>/examples/verify-independent.sh # 独立视角验收（只按文档走一遍）
```

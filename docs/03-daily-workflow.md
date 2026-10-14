# 日常操作手册

> 本手册里的**每条命令都在验收脚本里真实执行过**（`examples/verify-example.sh`、`examples/verify-java-project.sh`）。
> 它回答的是：**日常一圈到底怎么跑、每步该看到什么、卡住了怎么办。**

---

## 一、先分清三件事

| | 是什么 | 谁来做 |
|---|---|---|
| **变更目录** `.devflow/items/<日期>-<名字>/` | 一次需求的全部证据（需求、任务、验证、确认、发布、状态） | 引擎创建，你填写 |
| **门禁** | 项目自己声明的命令（构建、测试、契约…）+ **引擎的检查项**（`gate run` 会逐条列出：G0 G1 G1b G2 G4 G4b G5 G6 G7） | 引擎执行并留痕 |
| **确认点** | 必须由人拍板的三个位置（需求判据 / 契约冻结 / 发布批准） | **只有你能做** |

**一条硬规矩**：聊天里说的话不算证据。**确认必须写进 `APPROVALS.md`**，否则引擎到 `verified` 会拦下。

---

## 一·补 · 两条路径别混淆

| 路径 | 目的 | 看哪份文档 |
|---|---|---|
| **接入**（一次性） | 让工具在本项目可用、门禁可信 | `docs/02-adoption-guide.md`（十分钟路径） |
| **日常**（每个需求） | 一条变更从开工到发布 | 本手册 |

- **接入路径走完 ≠ 完成过一次变更** —— 它只验证"工具可用"。真正交付看本手册第三节。
- 接入时**不会**用到 `advance`；日常一定会用到。

## 二、每天开工的三步（1 分钟）

```bash
devflow doctor          # ① 门禁能不能信？（只看，不改任何东西）
devflow status          # ② 有哪些变更、卡在哪
devflow status <item> --digest   # ③ 某条变更的固定摘要（可直接贴进对话）
```

**期望看到**：doctor 结论是「可以开工」或「强度被削弱」；status 列出在办变更与各门禁符号。

> 如果 doctor 说「门禁不可信」，**先别开工** —— 按它给的「修法」逐条处理。它列出的每一条都会骗过你。

---

## 三、一条变更的完整一圈

以下以**轻档**（单端 UI / 文案类）为例，四档的差异见第五节。

### 步骤 1 · 立项并判档

```bash
devflow new --slug order-export --tier light --title "订单列表加导出按钮" --surface ui
```

- `--surface` 填 `ui` / `copy` / `internal` / `interface` / `data` / `auth` / `contract`；
- **填了 `contract` / `interface` / `data` / `auth` 时，引擎会检查档位是否匹配**（G7，启发式）。
- 想先看会生成什么，加 `--plan`（不写任何文件）。

**期望输出**：变更目录已创建；生成了 `SPEC.md`、`coding_report.md`、`verification.md`、`APPROVALS.md`。
（轻档**不生成契约** —— 它不需要。）

### 步骤 2 · 填需求（判据先于代码）

打开 `SPEC.md`，把每条验收标准的**判据**写清楚：

| AC | 判据 | 判据类型 | 责任方 |
|---|---|---|---|
| AC-1 | `./scripts/test.sh` 退出码 0 且测试计数 ≥ 1 | 命令 | 实现者 |
| AC-2 | 导出按钮出现在订单列表工具栏（截图 `screenshots/export.png`） | 画面 | 验证者 |

**判据类型只允许三个**：命令 / 画面 / 报告卡。写不出判据的标准，不要写进表里。

然后预演一次：

```bash
devflow advance <item> --to spec_ready --check
```

**期望看到**：`结论：可以推进`。若被拦下，它会**点名缺哪个文件**并给出修法。

### 步骤 3 · 确认需求判据（第 1 个人工确认点）

把 `APPROVALS.md` 里的占位改成真实内容：

```markdown
| 确认点 | 确认人 | 时间 | 结论 |
|---|---|---|---|
| 需求与判据 | 张三 | 2026-01-01T09:00:00Z | 通过 |
```

⚠ **占位内容不算证据**：`（姓名）`、`（ISO 时间）`、`通过 / 驳回` 都会被判为未填。

### 步骤 4 · 拆任务

轻档/微档可省。标准档以上填 `TASKS.md`，每条任务必须写全四列：

| T | 目标仓 | 写入范围 | 依赖 | 验收命令 | 对应AC |
|---|---|---|---|---|---|
| T-1 | order-api | `src/pages/order/` | 无 | `./scripts/test.sh` | AC-1 |

- **写入范围**决定子代理怎么切分（文件集合相交的任务合并给同一个）；
- **对应 AC** 断环会被引擎拦下。

### 步骤 5 · 实现并推进

```bash
devflow advance <item> --to implementing      # 轻档跳过契约，直达实现
```

实现完成后推进到 `tested`：

```bash
devflow advance <item> --to tested
```

**注意**：这一步会**自动执行项目门禁并留证据**，不需要你先手动跑 `gate run`。
若门禁失败，它会打印失败门禁的输出尾部，并给出下一步。

想单独看门禁结果（不改状态）：

```bash
devflow gate run <item>
```

**期望看到**：项目门禁逐条一行，含 `exit=`；**声明了计数的门禁还会显示 `count=`**（如 `test`），
以及「负向对照返回 1，门禁可信」（这句就是标签级门禁 G3 的结论，它不单独占一行）。
结论要么 `PASS`，要么 `BLOCKED —— 项目门禁:test`。

### 步骤 6 · 验证（独立视角）

```bash
devflow advance <item> --to verified
```

**期望看到**：要么通过，要么被拦下并点名。常见拦截有三类：

- 「确认记录未填」/「确认记录不足」——确认点没填或数量不够；
- 「验证记录缺少对 AC-x 的对照」——追溯链断环；
- 「**占位内容不算证据**」——模板里的 `（姓名）`、`通过 / 驳回`、`（一次测试…）` 这类单元**必须填实**，
  结构和章节齐全也不算数。

验证记录的写法（`verification.md`）：

| AC | 结论 | 证据 |
|---|---|---|
| AC-1 | 已实现 | 命令 `./scripts/test.sh` 退出码 0，Tests run: 12（见 STATUS.json） |
| AC-2 | 已实现 | 截图 `screenshots/export.png`，按钮位于工具栏右侧 |

**单人场景**：实现和验证必须**换会话**做 —— 同一上下文里你会"记得自己为什么这么写"，看不见自己写错了。

### 步骤 7 · 确认发布（第 2 个人工确认点）

标准档以上需要；轻档此时已满足。

### 步骤 8 · 发布并留报告卡

```bash
devflow advance <item> --to released --check   # 先看缺什么
devflow fill <item> --to released              # 按模板补（不覆盖已有文件）
```

然后填 `release/report.md` 的三节：发布内容（命令原文）、验证证据、**观察窗口（48 小时）**。
填完再推进：

```bash
devflow advance <item> --to released
```

### 步骤 9 · 查看与汇总

```bash
devflow status <item>          # 单条详情
devflow status                 # 全项目
devflow report                 # 生成只读看板 .devflow/board.html
```

---

## 四、卡住了怎么办

| 症状 | 怎么做 |
|---|---|
| `结论：现在推不过去 —— G1` | 运行 `devflow fill <item> --to <目标状态>` 按模板补；它会告诉你补了什么、哪些需手写 |
| `结论：现在推不过去 —— G1b` | 看「下一步」里的具体条目：AC 缺判据 / 任务缺列 / 验证没覆盖 AC / **确认记录是占位** |
| `结论：现在推不过去 —— G2` | 门禁还没跑过。`devflow gate run <item>`，或直接 `advance --to tested`（会自动跑） |
| 门禁记 ⚠ 而不是 ✓ | 负向对照缺失或返回了 0（门禁恒真）。`devflow doctor` 会点名 |
| 计数抓不到（显示"证据未知"） | `count_regex` 与该栈真实输出不匹配。跑 `devflow adapters` 对照内置模板；doctor 的 D11 也会点名 |
| 不知道本项目是哪个技术栈 | `devflow adapters` 会按 `pom.xml` / `package.json` / `pyproject.toml` / `go.mod` 识别 |
| 不知道 `--tier` / `--surface` / `--stack` 能填什么 | `devflow new --help` / `devflow init --help`。非法值会直接报错退出（不会静默接受） |
| 不知道 item 名字 | `devflow status` 列出；格式是 `<日期>-<变更名>` |
| `BLOCKED —— 项目门禁:test` | 看该门禁行的 `exit=` 与输出尾部；测试数为 0 也会被判失败（刻意的） |
| `非法状态转移` | 状态只能按顺序走。确需跳步用 `--force`（会留下绕过门禁的留痕） |
| 确认填了还是不过 | 检查三列是否都是**真实值**：括号占位、`通过 / 驳回` 这种二选一都不算填 |
| 改完还是旧结果 | 状态推进是显式的：先 `--check` 看，再真推进 |

**一条通用原则**：**每次只动一个状态，动之前先 `--check`。** 预演是只读的，不会改任何文件。

---

## 五、四档的差异（一张表）

| 档 | 建时生成 | 契约 | 确认点 | 典型命令序列 |
|---|---|---|---|---|
| 微 | 仅 STATE | — | 0 | `new --tier micro` → `gate run` → （可选）`advance --to released` |
| 轻 | SPEC + 实现报告 + 验证 + 确认 | 不需要 | 1（需求判据） | `new --tier light` → 填 SPEC → `advance --to spec_ready` → `advance --to implementing` → `advance --to tested` → 填确认 → `advance --to verified` → `fill --to released` → 填报告 → `advance --to released` |
| 标 | 上面 + 任务 + 契约模板 | **可选** | 2（需求判据、发布批准） | 同上，但建议填 `TASKS.md` |
| 重 | 全套 | **强制** | 3（+ 契约冻结） | 填 `CONTRACT.md` → `advance --to contracted` → 再并行实现 |

**微档的终点**：跑完 `gate run` 就算完工；想让状态也走到头，可继续
`advance --to spec_ready` → `implementing` → `tested` → `verified` → `released`（微档不需要任何文档与确认）。
完成后可用 `devflow archive` 归档（默认空跑，加 `--go` 才真移动）。

**确认记录模板按档位渲染**：micro 不生成；light 只有「需求与判据」1 行；standard 2 行；heavy 3 行。
所以不用担心"多余的行要不要填" —— 不需要的行根本不会出现。

**标准档的契约是"可选"**：想要契约就走 `contracted` 状态；不需要就直接 `spec_ready → implementing`。
**重档的契约是"强制"**：`CONTRACT.md` 缺失时预演会点名拦下。

---

## 六、确认点为什么是两段式

**子代理无法向用户提问**（宿主机制决定）。所以需要人拍板的地方，只能在编排者（主会话）停下：

```
引擎跑到确认点 → 停下来 → 你确认 → 写进 APPROVALS.md → 引擎继续
```

**为什么不用弹窗**：口头/弹窗确认无法追溯。确认必须落在文件里，事后能回答"谁在什么时候批的"。

---

## 七、每步"期望看到什么"（速查）

| 命令 | 期望 |
|---|---|
| `devflow doctor` | 结论三选一：可以开工 / 强度被削弱 / 门禁不可信；每条发现都给修法 |
| `devflow new ...` | 变更目录 + 该档位应有的产物骨架；重复新建会被拒绝 |
| `devflow advance ... --check` | `结论：可以推进` 或 `现在推不过去 —— 点名到具体产物` |
| `devflow advance ... --to tested` | 自动跑门禁；失败时打印失败门禁的输出尾部 |
| `devflow gate run` | 每个门禁一行：`exit=`（有计数的另有 `count=`）、负向对照是否可信；结论 PASS 或 BLOCKED **并附下一步**。**加 `--to <状态>` 才会按目标状态做内容层校验**。多测试类时 `count=` 是**逐类累加**的保守值 |
| `devflow adapters --apply <栈> --demo --force-scripts` | 本机没装工具链时，切到该栈的演示脚本（只覆盖适配器自己的脚本，用户脚本不动） |
| `devflow archive --go` | 归档**已 released** 且同时满足「超过 90 天」与「不在最近 20 条内」的变更 |
| `devflow fill ...` | 列出已补/跳过/需手写的产物；绝不覆盖已有文件 |
| `devflow report` | 生成 `.devflow/board.html`（只读视图） |
| `devflow archive` | 默认空跑，打印将归档哪些；加 `--go` 才真移动 |
| `devflow adapters` | 列出技术栈适配器、识别当前目录；每个栈的 `count_regex` 都能抓到自己的样本输出 |
| `devflow <命令> --help` | 该命令的作用 / 用法 / 参数取值 / 示例（**取值不确定时先看这里**） |

---

## 八、不要做的事

- ❌ 不要在没跑 `--check` 的情况下直接推进（预演是零成本的）
- ❌ 不要把 `通过 / 驳回` 这类占位留在 `APPROVALS.md` 里
- ❌ 不要靠"我在对话里确认过了"代替文件记录
- ❌ 不要把测试数改成 0 当作"暂时通过"（引擎会拦，改了也只是自欺）
- ❌ 不要在同一个会话里既实现又验证
- ❌ 不要手工改 `STATE` 与 `STATUS.json`（G5 会报不一致；`--force` 才是留痕的逃生舱）

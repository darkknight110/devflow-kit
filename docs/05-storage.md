# 产物存放规则

> 回答一个问题：**devflow 产生的文件应该存在哪里、是否入库、能活多久。**
>
> 事实来源是 [`spec/storage.json`](../spec/storage.json)（机器可读）；本文档是它面向人的说明。
> 两者不一致时以 `spec/storage.json` 为准。

---

## 一、为什么需要规则

本产品是**通用工作流**：一份安装要服务多个工作区、多个仓、多种项目类型。没有统一的存放规则，就会出现两类真实事故：

1. **该共享的没共享** —— 契约与验收判据留在某人机器上，评审看不到；
2. **该走的还在** —— "待推送提交清单"这类**合并后立刻过时**的内容被提交进仓库。

历史教训：曾把四类产物混在 `.devflow/items/` 里，再用一条 `.gitignore` **整体排除** —— 结果是"该共享的没共享、该走的还在"。所以必须先按**生命周期**分类。

---

## 二、四类产物（按生命周期，不是按内容）

| 类 | 寿命 | 给谁看 | 入库 |
|---|---|---|---|
| **① 契约与决策** | 永久（它就是团队的约定） | 团队 + 后人 | ✅ |
| **② 执行证据** | 一次变更 | 评审者 | ✅ |
| **③ 机器状态** | 秒级 / 可重算 | 只有工具自己 | ❌ |
| **④ 渲染产物** | 生成那一刻 | 当下要读的人 | ❌ |

**核心判断**：*这东西三个月后还有人需要吗？* 需要 ⇒ 入库；不需要 ⇒ 放 `.local/`。

---

## 三、四层作用域

```
① 工具安装（全局一份，只读）
   <kit>/                            代码、模板、正典文档

② 用户配置（跨工作区）
   ~/.config/devflow/config.json     默认档位、kit 路径等

③ 工作区（多仓协作的载体）
   <workspace>/.devflow/
     workspace.json                  纳入管理的仓
     changes/<变更>/item.json        跨仓索引：涉及哪些仓、各仓变更目录
     changes/<变更>/CONTRACT.md      跨仓契约快照

④ 仓（每个 git 仓库）
   <repo>/.devflow/
     items/<变更>/                   ①②类：**入库**
     .local/items/<变更>/            ③类：STATE、STATUS.json（**gitignore**）
     .local/report/                  ④类：看板（按需重算）
     archive/<年>/<变更>/            已 released 的归档
```

**为什么机器状态要单独放 `.local/`**：`STATE`、`STATUS.json` 每次运行都变，入库只会产生**无意义冲突**；而人写的产物必须能入库供评审。混在一起就无法用一条 `.gitignore` 区分。

---

## 四、逐产物归属

| 产物 | 类 | 位置 | 入库 |
|---|---|---|---|
| `CONTRACT.md` | ① | `items/<变更>/` | ✅ |
| `SPEC.md` | ① | 同上 | ✅（standard 及以上） |
| `TASKS.md` | ① | 同上 | ✅（standard 及以上） |
| `APPROVALS.md` | ① | 同上 | ✅（standard 及以上） |
| `coding_report.md` | ② | 同上 | ✅ |
| `verification.md` | ② | 同上 | ✅ |
| `release/report.md` | ② | 同上 | ⚠️ 回填观察窗口后再定 |
| `STATE`、`STATUS.json` | ③ | `.local/items/<变更>/` | ❌ |
| 门禁运行日志 | ③ | `.local/` | ❌ |
| `report` 看板 | ④ | `.local/report/` | ❌ |
| `devflow.json` | ① | 仓根 | ✅ |
| `scripts/*-should-fail.sh` | ① | `scripts/` | ❌（生成物，`init` 可补齐） |

---

## 五、`.gitignore` 规则（由 `devflow init` 维护）

```gitignore
# devflow 机器状态与渲染产物（可重算，不入库；items/ 里的产物仍应入库）
.devflow/.local/
scripts/*-should-fail.sh
```

> ⚠️ **不要忽略整个 `.devflow/`** —— 那会把该入库的 `items/` 一起挡掉。
> 若你的仓里有旧规则 `​.devflow/`，`devflow init` 会自动升级为 `.devflow/.local/`。

---

## 六、工具自身产物放哪（agent / 使用者都适用）

| 产出 | 去处 |
|---|---|
| 校验、扫描的即时报 | **只打到 stdout**，不落盘 |
| 需要留存的过程记录 | `.devflow/items/<变更>/`（在工作流内） |
| 需别人排期的缺口 | **生成 issue 文本**，不要产文档（文档没有责任人、不会出现在看板） |
| 临时分析 | `/tmp`，**不要放仓库根目录** |

**仓库根目录不应出现 `devflow-*.md` 之类的游离产物** —— 体检的 **D13** 会告警。

---

## 七、存量仓迁移

```bash
devflow migrate-storage --dry-run   # 预演：看会移动哪些文件
devflow migrate-storage             # 执行：把 STATE/STATUS.json 移入 .local/items/
```

迁移只移动机器状态文件，**人写的产物一律不动**，且目标已存在时不覆盖。
体检的 **D13** 会主动点名"仍是旧存储布局"的变更。

---

## 八、留存策略

| 项 | 规则 |
|---|---|
| 活动变更 | 不设硬上限；`report` 在超过 20 个时提示归档 |
| 已 released | 90 天后提示归档到 `.devflow/archive/<年>/` |
| `CONTRACT.md` | **永久保留**（它是团队约定） |

> 没有留存策略的目录一定会烂。归档是**移动而非删除**。

---

## 九、相关文档

| 文档 | 回答 |
|---|---|
| 本文档 + `spec/storage.json` | **放哪、是否入库、活多久** |
| [`04-standards.md`](04-standards.md) | 要求是什么、怎么改 |
| [`01-workflow-spec.md`](01-workflow-spec.md) | 工作流正典 |
| [`03-daily-workflow.md`](03-daily-workflow.md) | 日常怎么用 |

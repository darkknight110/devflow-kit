#!/usr/bin/env bash
# 第五套端到端：**人的闭环**（干净目录、逐句模拟人话）
#
# 目的：证明"人只说人话 → 工作流落到正确环节 → 产出可验证"这条链路是通的。
# 与前三套的区别：那几套验"引擎行为"，本套验"人的使用路径"。
#
# 铁律：失败必须显示原因（不许 >/dev/null 后静默退出）；无法只靠聊天完成的部分要**明确列出**。
set -uo pipefail

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DF="$KIT/bin/devflow"
P="$(mktemp -d)/human-loop"
mkdir -p "$P"; cd "$P"

PASS=0; FAIL=0
pass() { printf '  [OK] %s\n' "$1"; PASS=$((PASS+1)); }
fail() { printf '  [NG] %s\n' "$1"; FAIL=$((FAIL+1)); }
step() { printf '\n== %s ==\n' "$1"; }

# 模拟"模型按 SKILL.md 调用 CLI"的动作：人话 → 命令
say() { printf '  💬 用户说：%s\n' "$1"; }

step "0. 干净环境（无任何预设上下文）"
printf '{"name":"human-loop","version":"1.0.0"}\n' > package.json
git init -q 2>/dev/null || true
say "我要在这个项目上用 devflow"
"$DF" init --name human-loop >/dev/null 2>&1 && pass "接入完成（init）" || { fail "init 失败"; "$DF" init --name human-loop; }
printf '#!/usr/bin/env bash\necho "build ok"\n' > scripts/build.sh
printf '#!/usr/bin/env bash\necho "Tests  6 passed"\n' > scripts/test.sh
chmod +x scripts/*.sh
if "$DF" doctor >/tmp/hl-doctor.log 2>&1; then
  pass "体检：$(grep -oE '结论：.*' /tmp/hl-doctor.log | head -1 | sed 's/结论：//')"
else
  fail "体检未通过"; head -12 /tmp/hl-doctor.log
fi

step "1. 人话：『优惠券快过期时想给用户提醒』"
say "优惠券快过期时想给用户提醒"
if "$DF" start >/tmp/hl-start.log 2>&1; then
  grep -q "说人话即可" /tmp/hl-start.log && pass "start 给出唯一入口与引导" || { fail "start 输出不含引导"; head -8 /tmp/hl-start.log; }
else
  fail "start 执行失败"; head -8 /tmp/hl-start.log
fi

step "2. 澄清：必答清单必须逐项回答（答不上来标未决）"
ITEM="2026-10-14-coupon-remind"
"$DF" new --date 2026-10-14 --slug coupon-remind --tier standard --title "优惠券过期提醒" \
  --owner 张三 --repos human-loop --surface ui --surface data >/dev/null 2>&1 \
  && pass "建变更：$ITEM" || fail "建变更失败"

# 仓级架构声明：新变更继承架构约束（视图里也可点开看）
mkdir -p .devflow
cat > .devflow/architecture.md <<'EOS'
# 项目架构与约定

> **产物**：架构声明（仓级、永久）

## 一、技术栈

| 层 | 技术 | 版本 | 说明 |
|---|---|---|---|
| 前端 | Taro 3 + React 18 | 3.6 | 小程序 |
| 后端 | Spring Boot | 3.2 | 单体服务 |
| 数据库 | MySQL | 8.0 | 券与提醒记录 |

## 二、分层与目录约定

| 目录 | 允许放什么 | 禁止放什么 |
|---|---|---|
| src/services/ | 只放请求封装 | 不放页面逻辑 |
| src/pages/ | 只放页面与交互 | 禁止直接发请求 |

## 三、架构决策（ADR 式）

| # | 决策 | 背景 | 结论 | 影响 |
|---|---|---|---|---|
| ADR-1 | 网关前缀由谁负责 | 多仓各自拼接易漂移 | 统一由 env 注入 | 禁止硬编码前缀 |

## 四、不可违反的约束

| # | 约束 | 为什么 | 谁来保证 |
|---|---|---|---|
| C-1 | 不得绕过网关直连服务 | 鉴权与可观测性都在网关 | 评审 |

## 五、需求必答清单（项目自定义）

| # | 必答问题 | 为什么本项目必须问 |
|---|---|---|
| Q-1 | 该字段是否需要同步到历史数据？ | 本项目有历史数据迁移负担 |
EOS
pass "架构声明已落盘（技术栈/分层/ADR/约束/项目必答项）"

if "$DF" clarify "$ITEM" >/tmp/hl-clarify.log 2>&1 && grep -q "未决：" /tmp/hl-clarify.log; then
  grep -qE "未决：[0-9]+/[0-9]+" /tmp/hl-clarify.log     && pass "澄清清单已生成（含通用必答项与项目追加项：$(grep -oE '未决：[0-9]+/[0-9]+' /tmp/hl-clarify.log | head -1)）"     || { fail "澄清清单未生成"; head -10 /tmp/hl-clarify.log; }
else
  fail "clarify 执行失败"; head -10 /tmp/hl-clarify.log
fi

# 未决项必须拦住实现 —— 这是"不许带着风险进实现"的机械保证
if "$DF" advance "$ITEM" --to spec_ready >/dev/null 2>&1; then
  if "$DF" advance "$ITEM" --to implementing >/tmp/hl-block.log 2>&1; then
    fail "未决项竟允许推进到实现"
  else
    grep -q "需求澄清仍有未决项" /tmp/hl-block.log \
      && pass "未决项拦住实现（门禁给明原因）" \
      || { fail "拦住但未说明原因"; head -6 /tmp/hl-block.log; }
  fi
else
  fail "spec_ready 失败"; "$DF" advance "$ITEM" --to spec_ready --check 2>&1 | tail -6
fi

# 逐条回答（人话 → clarify --answer）：通用项 + 项目追加项都要答
# 用 while read 逐行读取（`for q in $QIDS` 在 set -u 下会把中文当变量名，实测报错）
QCOUNT=0
while IFS= read -r q; do
  [ -n "$q" ] || continue
  "$DF" clarify "$ITEM" --answer "$q" --text "已确认 $q" >/dev/null 2>&1
  QCOUNT=$((QCOUNT+1))
done <<EOF
$(grep -oE '(U|Q)-[0-9]+' ".devflow/items/$ITEM/CLARIFY.md" | sort -u)
EOF
if "$DF" clarify "$ITEM" 2>&1 | grep -qE "未决：0/[0-9]+"; then
  pass "逐条回答后未决清零（共 ${QCOUNT} 项，含项目追加的 Q-x）"
else
  fail "回答后仍有未决项"; "$DF" clarify "$ITEM" 2>&1 | tail -8
fi

step "3. 契约：标准档涉数据面，冻结契约（模板必须填实）"
cat > ".devflow/items/$ITEM/CONTRACT.md" <<'EOS'
# CONTRACT · 优惠券过期提醒

> **产物**：跨边界契约（冻结件）　**变更**：2026-10-14-coupon-remind　**档位**：标（standard）　**最后更新**：2026-10-14

## 所有权

| 端点 | 方法 | owner | surface |
|---|---|---|---|
| /api/marketing/coupon/expiring | GET | human-loop（后端） | data |

## 消费者

| 消费方 | 依赖什么 | 需要的兼容 |
|---|---|---|
| 消息中心 | 返回即将过期券列表 | 加字段 |

## 兼容策略

| 策略 | 说明 | 是否破坏性 |
|---|---|---|
| 加字段 | 新增接口，不改既有返回 | 否 |

## 校验方式

| 校验方式 | 命令 | 通过条件 |
|---|---|---|
| 契约断言 | ./scripts/test.sh | 退出码 0 且覆盖"提前 3 天命中/已过期不提醒" |

## 破坏性判定

| 问题 | 结论 |
|---|---|
| 是否有消费方会因此中断 | 否（新增接口） |
| 是否需要并行发版窗口 | 否 |
| 回滚方式 | git revert 对应提交 |
EOS
pass "CONTRACT.md 已冻结（所有权唯一、兼容策略已选、校验方式可运行）"

step "4. 落 SPEC：把答案提炼成可验收的判据"
cat > ".devflow/items/$ITEM/SPEC.md" <<'EOS'
# SPEC · 优惠券过期提醒

> **产物**：需求与验收标准　**变更**：2026-10-14-coupon-remind　**档位**：标（standard）　**最后更新**：2026-10-14

## 身份

| 键 | 值 |
|---|---|
| item | 2026-10-14-coupon-remind |
| tier | standard |
| owner | 张三 |
| repos | human-loop |
| change_surface | ui、data |

## 验收标准

| AC | 判据 | 判据类型 | 责任方 |
|---|---|---|---|
| AC-1 | `./scripts/test.sh` 退出码 0 且用例数 ≥ 1，覆盖"提前 3 天命中"与"已过期不提醒" | 命令 | 后端 |
| AC-2 | 消息中心出现"优惠券即将过期"条目，点击进入券详情 | 画面 | 前端 |
| AC-3 | 同一张券只提醒一次（重复触发返回已提醒） | 命令 | 后端 |

## 不做什么

| 项 | 说明 |
|---|---|
| 不做短信/推送通道 | 本期只用站内信，通道扩展另开变更 |
EOS
pass "SPEC 已落盘（3 条 AC，含责任方）"

step "5. 分派：按责任层拆任务（前端 / 后端）"
cat > ".devflow/items/$ITEM/TASKS.md" <<'EOS'
# TASKS · 优惠券过期提醒

> **产物**：任务分解　**变更**：2026-10-14-coupon-remind　**档位**：标（standard）　**最后更新**：2026-10-14

## 任务

| T | 目标仓 | 负责层 | 写入范围 | 依赖 | 状态 | 负责人 | 验收命令 | 对应AC |
|---|---|---|---|---|---|---|---|---|
| T-1 | human-loop | 数据库 | db/migrations/008.sql | 无 | 待开始 | 李四 | ./scripts/test.sh | AC-1 |
| T-2 | human-loop | 后端 | src/services/coupon-remind.ts | T-1 | 待开始 | 张三 | ./scripts/test.sh | AC-1、AC-3 |
| T-3 | human-loop | 前端 | src/pages/message | T-2 | 待开始 | 王五 | ./scripts/test.sh | AC-2 |
EOS
if "$DF" doctor >/tmp/hl-d15.log 2>&1; then
  pass "体检通过（责任层已覆盖）"
else
  if grep -q "D15" /tmp/hl-d15.log; then
    fail "D15 报缺层（分派不完整）"; grep -A2 "D15" /tmp/hl-d15.log
  else
    pass "体检有非阻断提示（非 D15）"
  fi
fi
# 反证：去掉前端任务 ⇒ D15 必须报缺层
cp ".devflow/items/$ITEM/TASKS.md" /tmp/hl-tasks.bak
grep -v "T-3" /tmp/hl-tasks.bak > ".devflow/items/$ITEM/TASKS.md"
"$DF" doctor >/tmp/hl-d15b.log 2>&1
if grep -q "任务缺责任层\|D15" /tmp/hl-d15b.log; then
  pass "去掉前端任务后 D15 报出缺层（分派漏层可被机械发现）"
else
  fail "去掉整层任务却未报警"; grep -E "结论|D15" /tmp/hl-d15b.log | head -4
fi
cp /tmp/hl-tasks.bak ".devflow/items/$ITEM/TASKS.md"

step "6. 任务级干预：人话『T-2 卡住了』"
if "$DF" task "$ITEM" T-2 --status 阻塞 --note "等迁移脚本评审" >/tmp/hl-task.log 2>&1; then
  grep -q "阻塞（等迁移脚本评审）" ".devflow/items/$ITEM/TASKS.md" \
    && pass "阻塞已落盘且带原因" || fail "阻塞原因未写入任务表"
else
  fail "任务干预失败"; head -6 /tmp/hl-task.log
fi
# 阻塞不给原因必须被拒
if "$DF" task "$ITEM" T-3 --status 阻塞 >/dev/null 2>&1; then
  fail "阻塞未给原因却被接受"
else
  pass "阻塞必须给原因（未给则拒绝）"
fi
# 解除阻塞
"$DF" task "$ITEM" T-2 --status 进行中 >/dev/null 2>&1 && pass "可解除阻塞并继续"

step "7. 实现 → 提测 → 验证（机械部分由引擎判定）"
"$DF" advance "$ITEM" --to implementing >/dev/null 2>&1 && pass "-> 实现中" || fail "-> 实现中 失败"
cat > ".devflow/items/$ITEM/coding_report.md" <<'EOS'
# 实现报告 · 优惠券过期提醒

> **产物**：实现报告　**变更**：2026-10-14-coupon-remind　**最后更新**：2026-10-14

## 改了什么

| 文件 | 改动 |
|---|---|
| src/services/coupon-remind.ts | 新增过期提醒扫描与去重 |
| db/migrations/008.sql | 新增提醒记录表 |
| src/pages/message/index.tsx | 消息中心展示提醒条目 |

## 涉及提交

| 仓 | 提交 | 说明 |
|---|---|---|
| human-loop | abc1234 | 过期提醒主逻辑与去重 |
EOS
if "$DF" advance "$ITEM" --to tested >/dev/null 2>&1; then
  pass "-> 待验证（项目门禁全绿）"
else
  fail "-> 待验证 失败"; "$DF" advance "$ITEM" --to tested --check 2>&1 | tail -8
fi

# 验证记录：只写"已通过"必须被拦下（证明"结论必须有证据"）
cat > ".devflow/items/$ITEM/verification.md" <<'EOS'
# 验证记录 · 优惠券过期提醒

> **产物**：验证记录　**变更**：2026-10-14-coupon-remind　**最后更新**：2026-10-14

## 逐条对照

| AC | 结论 | 证据 |
|---|---|---|
| AC-1 | 已通过 | （待填） |
| AC-2 | 已通过 | （待填） |
| AC-3 | 已通过 | （待填） |

## 结论

全部通过

## 证据

```
$ ./scripts/test.sh
（输出）
```
EOS
if "$DF" advance "$ITEM" --to verified >/dev/null 2>&1; then
  fail "无证据的『已通过』竟被接受"
else
  pass "结论缺证据被拦下（占位内容不算证据）"
fi

cat > ".devflow/items/$ITEM/verification.md" <<'EOS'
# 验证记录 · 优惠券过期提醒

> **产物**：验证记录　**变更**：2026-10-14-coupon-remind　**最后更新**：2026-10-14

## 逐条对照

| AC | 结论 | 证据 |
|---|---|---|
| AC-1 | 已通过 | src/services/coupon-remind.ts:41 提前 3 天命中；exit=0 |
| AC-2 | 已通过 | 截图 src/pages/message/screenshot.png（消息中心出现提醒条目） |
| AC-3 | 已通过 | src/services/coupon-remind.ts:63 重复触发返回 already_reminded；exit=0 |

## 结论

三条 AC 均通过；边界（已过期不提醒）由 AC-1 的用例覆盖

## 证据

```
$ ./scripts/test.sh
Tests  6 passed (6)
退出码 0
```

## 未验证项

| 未验证项 | 原因 | 如何补验证 | 是否接受风险 |
|---|---|---|---|
| 真机点击跳转 | 无设备 | 需真机与测试环境 | 接受（本期只验契约层） |
EOS
cat > ".devflow/items/$ITEM/APPROVALS.md" <<'EOS'
# 确认记录 · 优惠券过期提醒

> **产物**：人工确认记录　**变更**：2026-10-14-coupon-remind　**最后更新**：2026-10-14

## 确认记录

| 确认点 | 确认人 | 时间 | 结论 |
|---|---|---|---|
| 需求与判据 | 张三 | 2026-10-14T09:00:00Z | 通过 |
| 发布批准 | 张三 | 2026-10-14T17:00:00Z | 通过 |
EOS
if "$DF" advance "$ITEM" --to verified >/dev/null 2>&1; then
  pass "-> 已验证（逐条 AC 均有证据）"
else
  fail "-> 已验证 失败"; "$DF" advance "$ITEM" --to verified --check 2>&1 | tail -8
fi

step "8. 发布：报告 + 观察窗口"
"$DF" fill "$ITEM" --to released >/dev/null 2>&1
cat > ".devflow/items/$ITEM/release/report.md" <<'EOS'
# 发布报告 · 优惠券过期提醒

> **产物**：发布报告　**变更**：2026-10-14-coupon-remind　**最后更新**：2026-10-14

## 发布内容

| 仓 | 提交 | 说明 |
|---|---|---|
| human-loop | abc1234 | 券过期提醒（站内信） |

## 验证证据

| 判据 | 命令 | 结果 |
|---|---|---|
| 契约与逻辑 | ./scripts/test.sh | Tests 6 passed，退出码 0 |

## 观察窗口

| 项 | 内容 |
|---|---|
| 时间范围 | 2026-10-14 18:00 至 2026-10-16 18:00（48 小时） |
| 关键指标 | 提醒去重率、消息中心打开率 |
| 结论 | 待观察（需真机与线上数据回填） |
EOS
if "$DF" advance "$ITEM" --to released >/dev/null 2>&1; then
  pass "-> 已发布"
else
  fail "-> 已发布 失败"; "$DF" advance "$ITEM" --to released --check 2>&1 | tail -8
fi

step "9. 视图：每一步都可在浏览器里点开查看"
if "$DF" view --out "$P/view.html" >/tmp/hl-view.log 2>&1; then
  for k in "需求澄清" "责任层" "项目架构与约定"; do
    grep -q "$k" "$P/view.html" && pass "视图含：$k" || fail "视图缺少：$k"
  done
  # 视图约束（第 11 期校准）：**不联网、不依赖外部库**为主；允许一段内联脚本做联动过滤。
  # 关键要求：① 无 external script；② 禁用 JS 时信息仍完整（脚本只显隐、不生成内容）。
  if grep -qE '<script[^>]+src=' "$P/view.html"; then
    fail "视图引用了外部脚本（要求离线可用、无外部依赖）"
  elif grep -qE 'https?://[^"'"'"' ]+\.(js|css)' "$P/view.html"; then
    fail "视图引用了外部资源"
  else
    pass "视图自包含、无外部依赖（$(wc -c < "$P/view.html" | tr -d ' ') 字节）；含联动脚本但不联网"
  fi
  # 联动要素必须存在（阶段芯片可点、任务可被过滤）
  if grep -q 'data-stage=' "$P/view.html" && grep -q 'data-stages=' "$P/view.html" && grep -q 'fbtn' "$P/view.html"; then
    pass "阶段芯片与任务列表联动（芯片带 data-stage，任务带 data-stages，且有过滤按钮）"
  else
    fail "缺少阶段↔任务联动的要素"
  fi
else
  fail "view 生成失败"; head -6 /tmp/hl-view.log
fi

step "10. 明确列出：无法只靠聊天完成的部分"
cat <<'EOS'
  以下环节**必须有真人/真机/真时间**，本工作流只能"准备好材料并拦住省略"：
    · 人工确认点的签核（AP1/AP2/AP3）—— agent 不得代填结论
    · 真实代码实现（本脚本用占位实现代替，真实验证需人/模型真的改代码）
    · 真机行为与画面验收（AC-2 的截图需要设备与测试环境）
    · 观察窗口结论回填（需要 48 小时真实运行）
    · 第二个人的独立复核（单人场景无法自证独立）
  这些在 verification.md 的「未验证项」与 release/report.md 的「观察窗口」中已如实登记。
EOS
pass "未验证项已如实登记（未验证 ≠ 可以）"

printf '\n── 结果 ──\n  通过 %d 项，失败 %d 项\n' "$PASS" "$FAIL"
if [ "$FAIL" -eq 0 ]; then
  echo "  第五套端到端验收通过（人的闭环）"
  exit 0
fi
echo "  第五套端到端验收失败"
exit 1

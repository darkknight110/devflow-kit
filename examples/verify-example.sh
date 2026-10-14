#!/usr/bin/env bash
# 端到端验收：单仓样例从 draft 走到 released。
# 第 1 期唯一的验收入口：一条命令、可复现、零人工。
set -euo pipefail

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EX="$KIT/examples/single-repo-service"
DEVFLOW="node $KIT/scripts/cli.mjs"
ITEM="2026-01-01-demo"

pass() { printf '  [OK] %s\n' "$1"; }
fail() { printf '  [NG] %s\n' "$1"; FAILED=1; }
FAILED=0

echo "== 0. 准备样例工程（清理上一次运行） =="
rm -rf "$EX/.devflow"
chmod +x "$EX"/scripts/*.sh 2>/dev/null || true
cd "$EX"
pass "样例目录：$EX"

echo
echo "== 1. 自检：门禁体系本身必须有效 =="
if NO_COLOR=1 node "$KIT/scripts/selfcheck.mjs" >/tmp/devflow-selfcheck.log 2>&1; then
  pass "自检 10/10 通过"
else
  fail "自检未通过"; sed -n '1,20p' /tmp/devflow-selfcheck.log; exit 1
fi

echo
echo "== 2. 新建变更（轻档）：目录非空即拒绝 =="
$DEVFLOW new --slug demo --date 2026-01-01 --tier light --title "样例：订单导出按钮" \
  --owner "样例负责人" --repos single-repo-service --surface ui >/tmp/devflow-new.log 2>&1
pass "已新建 $ITEM"
if $DEVFLOW new --slug demo --date 2026-01-01 --tier light >/dev/null 2>&1; then
  fail "重复新建竟然成功（应拒绝非空目录）"
else
  pass "重复新建被拒绝（不覆盖已有内容）"
fi

echo
echo "== 3. 缺件必须阻断（引擎层断言：删掉产物后推进必须被拒绝） =="
D=".devflow/items/$ITEM"
cp "$D/SPEC.md" /tmp/devflow-spec-backup.md
rm -f "$D/SPEC.md"
if $DEVFLOW advance $ITEM --to spec_ready >/tmp/devflow-block.log 2>&1; then
  fail "缺 SPEC 竟然允许推进到 spec_ready"
else
  pass "缺 SPEC 被拒绝推进（$(grep -c '缺少产物' /tmp/devflow-block.log) 条缺件提示）"
fi
cp /tmp/devflow-spec-backup.md "$D/SPEC.md"

echo "== 4. 补齐产物 =="
D=".devflow/items/$ITEM"
cat > "$D/SPEC.md" <<'EOF'
# SPEC · 样例：订单导出按钮

## 身份

| 项 | 值 |
|---|---|
| item | 2026-01-01-demo |
| 档位 | 轻（light） |
| 负责人 | 样例负责人 |
| 目标仓 | single-repo-service |
| 变更面 | ui |

## 验收标准

| AC | 判据 | 判据类型 | 责任方 |
|---|---|---|---|
| AC-1 | ./scripts/test.sh 退出码 0 且 Tests run ≥ 1 | 命令 | 实现者 |
| AC-2 | 导出按钮出现在订单列表工具栏 | 画面 | 验证者 |
| AC-3 | 改动文件清单写入实现报告 | 报告卡 | 实现者 |

## 不做什么

- 不改后端接口
- 不改权限模型
EOF
cat > "$D/TASKS.md" <<'EOF'
# TASKS · 样例：订单导出按钮

## 任务

| T | 目标仓 | 负责层 | 写入范围 | 依赖 | 状态 | 负责人 | 验收命令 | 对应AC |
|---|---|---|---|---|---|---|---|---|---|
| T-1 | single-repo-service | 后端 | src/pages/order/ | 无 | 待开始 | 张三 | ./scripts/test.sh | AC-1 |
| T-2 | single-repo-service | 后端 | src/pages/order/ | T-1 | 待开始 | 张三 | ./scripts/build.sh | AC-1 |
EOF
cat > "$D/coding_report.md" <<'EOF'
# 实现报告 · 样例：订单导出按钮

## 改了什么

- src/pages/order/List.tsx：工具栏新增 export 动作
- scripts/test.sh：把测试计数输出到 stdout（供门禁抓取）

## 涉及提交

| 提交 | 仓库 | 说明 |
|---|---|---|
| demo0001 | single-repo-service | 新增导出按钮 |
EOF
cat > "$D/verification.md" <<'EOF'
# 验证记录 · 样例：订单导出按钮

## 逐条对照

| AC | 结论 | 证据 |
|---|---|---|
| AC-1 | 已实现 | 命令 ./scripts/test.sh 退出码 0，Tests run: 3（见 STATUS.json lastRun.records） |
| AC-2 | 已实现 | 截图 screenshots/order-export.png，按钮位于工具栏右侧 |
| AC-3 | 已实现 | coding_report.md 第 5-8 行列出改动文件清单 |

## 结论

- 总体结论：已实现
- 阻断项：无
- 基线豁免：无

## 证据

- 命令原文与输出尾部保存在 STATUS.json 的 lastRun.records 中
EOF
# 把 SPEC/TASKS/验证记录里的模板占位填实（占位内容不算证据）
cat > "$D/SPEC.md" <<'EOF'
# SPEC · 样例：订单导出按钮

## 身份

| 项 | 值 |
|---|---|
| item | 2026-01-01-demo |
| 档位 | 轻（light） |
| 负责人 | 张三 |
| 目标仓 | single-repo-service |
| 变更面 | ui |

## 验收标准

| AC | 判据 | 判据类型 | 责任方 |
|---|---|---|---|
| AC-1 | ./scripts/test.sh 退出码 0 且 Tests run ≥ 1 | 命令 | 实现者 |

## 不做什么

- 不改后端接口
EOF
cat > "$D/APPROVALS.md" <<'EOF'
# 确认记录 · 样例：订单导出按钮

## 确认记录

| 确认点 | 确认人 | 时间 | 结论 |
|---|---|---|---|
| 需求与判据 | 样例负责人 | 2026-01-01T09:00:00Z | 通过 |
| 发布批准 | 样例负责人 | 2026-01-01T10:00:00Z | 通过 |
EOF
touch screenshots/order-export.png
pass "产物已补齐"

echo
echo "== 5. 运行门禁 =="
set +e
$DEVFLOW gate run $ITEM >/tmp/devflow-gate.log 2>&1
set -e
grep -q "门禁可信" /tmp/devflow-gate.log && pass "负向对照生效（门禁可信）" || { fail "负向对照未生效"; sed -n '1,30p' /tmp/devflow-gate.log; }
grep -q "结论：PASS" /tmp/devflow-gate.log && pass "Kit 门禁结论 PASS" || { fail "Kit 门禁未 PASS"; grep -E "G1b|G1 |结论" /tmp/devflow-gate.log | head -5; }

echo
echo "== 6. 推进状态（轻档跳过契约） =="
$DEVFLOW advance $ITEM --to spec_ready >/dev/null; pass "-> spec_ready"
$DEVFLOW advance $ITEM --to implementing >/dev/null; pass "-> implementing"
$DEVFLOW advance $ITEM --to tested >/dev/null; pass "-> tested"
$DEVFLOW advance $ITEM --to verified >/dev/null; pass "-> verified"

echo
echo "== 7. 发布与观察窗口 =="
cat > "$D/release/report.md" <<'EOF'
# 发布报告 · 样例：订单导出按钮

## 发布内容

- 命令原文：./scripts/build.sh（退出码 0）
- 产物部署至预发环境，静态资源 hash 已更新

## 验证证据

- ./scripts/test.sh 退出码 0，Tests run: 3
- 真实页面访问：/order/list 返回 200，导出按钮可见

## 观察窗口

- 2026-01-01 10:00 至 2026-01-03 10:00（48 小时）
- 关键指标：页面错误率 0%、导出点击 12 次、无用户反馈
EOF
$DEVFLOW advance $ITEM --to released >/dev/null; pass "-> released"

echo
echo "== 8. 终态确认 =="
$DEVFLOW status $ITEM --digest
$DEVFLOW status $ITEM | grep -q "结论：可推进" && pass "终态：无阻断" || fail "终态仍有阻断"
$DEVFLOW report >/dev/null && test -s .devflow/board.html && pass "看板已生成（只读视图）"
if $DEVFLOW advance $ITEM --to draft >/dev/null 2>&1; then
  fail "非法转移（released -> draft）竟然被接受"
else
  pass "非法状态转移被拒绝"
fi

echo
echo
echo "== 9. 新人零误判路径（临时项目，真实走一遍） =="
TMP="$(mktemp -d)"
NAP="$TMP/proj"
mkdir -p "$NAP"
( cd "$NAP" && "$KIT/bin/devflow" init --name newcomer >/dev/null 2>&1 )
if ( cd "$NAP" && "$KIT/bin/devflow" doctor >/tmp/devflow-d1.log 2>&1 ); then
  fail "init 后 doctor 竟然判为可信（占位门禁未被识别）"
else
  pass "init 后 doctor 判为不可信（$(grep -o '阻断 [0-9]*' /tmp/devflow-d1.log | head -1)）"
fi
cat > "$NAP/scripts/build.sh" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p src
echo "build ok"
EOS
cat > "$NAP/scripts/test.sh" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
echo "Tests run: 5"
EOS
chmod +x "$NAP"/scripts/*.sh
if ( cd "$NAP" && "$KIT/bin/devflow" doctor >/tmp/devflow-d2.log 2>&1 ); then
  pass "换成真实命令后 doctor 判为可以开工"
else
  fail "换真实命令后 doctor 仍判不可信"; sed -n '1,20p' /tmp/devflow-d2.log
fi
( cd "$NAP" && "$KIT/bin/devflow" new --date 2026-10-13 --slug first --tier micro --title "首个变更" >/dev/null 2>&1 )
# 新增断言：`new` 必须真的建出目录。此前它静默失败过一次（未传 --date ⇒ 用了当天日期，
# 而脚本按固定日期查找），后续报错表现为"变更目录不存在"，根因被掩盖了很久。
if [ ! -d "$NAP/.devflow/items/2026-10-13-first" ]; then
  fail "new 未创建变更目录（items：$(ls "$NAP/.devflow/items" 2>/dev/null | tr '\n' ' ')，应为 2026-10-13-first）"
fi
if ( cd "$NAP" && "$KIT/bin/devflow" gate run 2026-10-13-first >/tmp/devflow-g1.log 2>&1 ); then
  pass "门禁通过（$(grep -o 'count=[0-9]*' /tmp/devflow-g1.log | head -1)）"
else
  fail "门禁应当通过却失败"; sed -n '1,20p' /tmp/devflow-g1.log
fi
sed -i '' 's/Tests run: 5/Tests run: 0/' "$NAP/scripts/test.sh"
if ( cd "$NAP" && "$KIT/bin/devflow" gate run 2026-10-13-first >/tmp/devflow-g2.log 2>&1 ); then
  fail "测试数为 0 竟然通过（假通过）"
else
  pass "测试数为 0 被拦下（结论：$(grep -o 'BLOCKED.*' /tmp/devflow-g2.log | head -1 | cut -c1-40)）"
fi
rm -rf "$TMP"

echo
echo "== 10. 确定性：同一蓝图两次生成必须一致 =="
DET="$(mktemp -d)"; A="$DET/a"; B="$DET/b"; mkdir -p "$A" "$B"
for D in "$A" "$B"; do
  ( cd "$D" && "$KIT/bin/devflow" init --name det >/dev/null 2>&1 )
  ( cd "$D" && "$KIT/bin/devflow" new --slug same --date 2026-01-01 --tier standard --title "确定性" --owner o --repos r --surface internal >/dev/null 2>&1 )
done
strip_ts() { sed -E 's/"(createdAt|updatedAt|at)": "[^"]*"/"\1": "X"/g' "$1"; }
# 机器状态在 .devflow/.local/items/（spec/storage.json STO-1）
if diff <(strip_ts "$A/.devflow/.local/items/2026-01-01-same/STATUS.json") <(strip_ts "$B/.devflow/.local/items/2026-01-01-same/STATUS.json") >/dev/null; then
  pass "STATUS.json 生成一致（忽略时间戳）"
else
  fail "STATUS.json 两次生成不一致"
fi
SAME=1
# STATE 是机器状态（.local/），文档是人写的产物（items/）
diff "$A/.devflow/.local/items/2026-01-01-same/STATE" "$B/.devflow/.local/items/2026-01-01-same/STATE" >/dev/null || SAME=0
for f in SPEC.md coding_report.md verification.md APPROVALS.md; do
  diff "$A/.devflow/items/2026-01-01-same/$f" "$B/.devflow/items/2026-01-01-same/$f" >/dev/null || SAME=0
done
[ "$SAME" -eq 1 ] && pass "产物文件生成一致（SPEC/实现报告/验证/确认）" || fail "产物文件两次生成不一致"
rm -rf "$DET"

echo
echo "== 11. 清理（样例产物不入库） =="
rm -rf "$EX/.devflow"
pass "已清理 .devflow（保持仓库可重复运行）"

echo
if [ "$FAILED" -eq 0 ]; then
  printf '端到端验收通过\n'
else
  printf '端到端验收失败\n'; exit 1
fi

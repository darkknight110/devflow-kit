#!/usr/bin/env bash
# 第二个验收场景：Java / Maven 风格项目。
# 目的：证明引擎不绑技术栈 —— 与 Node 样例的差异是「构建与测试的产物形态」，
#       而不是引擎行为。同时覆盖四档各自的状态路径与契约可选性。
set -euo pipefail

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEVFLOW="$KIT/bin/devflow"
P="$(mktemp -d)/order-api"
mkdir -p "$P"/src/main/java/com/example/order "$P"/src/main/resources "$P"/scripts
cd "$P"

# 把模板骨架里残留的占位替换成真实值（占位内容不算证据，G1b 会拦）。
# 这是采用者真正要做的事：模板只给结构，内容必须自己写。
fill_item() {
  local dir="$1"
  # 用 Python 做确定性替换（perl 单行正则易写出边界错误：实测把「需求与判据」整段吃掉）。
  # 只替换**已知的占位形态**，且**跳过产物头（首个 `## ` 之前）** —— 头部含「轻（light）」这类合法括号。
  python3 - "$dir" <<'PYFILL'
import io, re, sys, glob, os
d = sys.argv[1]
FIXED = {
    "通过 / 驳回": "通过",
    "已通过 / 未通过 / 未验证": "已通过",
    "已实现 / 未实现 / 阻断": "已实现",
}
ALLOW = {
    "姓名": "张三", "ISO 时间": "2026-10-13T09:00:00Z", "待填": "张三", "本仓": "order-api",
    "命令": "./scripts/test.sh", "路径": "src/x.ts", "一次测试 / 一次可观测探测：命令 + 期望结果": "exit=0",
    "只在一端可见时用画面：截什么、看到什么算通过": "截图：导出按钮出现且可点",
    "哈希": "abc1234", "文件或目录": "src/services", "文件": "src/services/a.ts",
    "一句话：改了什么、为什么": "按契约修正端点方法",
    "与 SPEC 一致的判据": "exit=0", "可执行的命令 + 期望结果": "exit=0",
    "仓名": "order-api", "SHA": "abc1234", "这次发布了什么": "修正契约对齐",
    "why": "x", "谁负责达成": "张三", "明确划掉的部分": "不改后端",
    "为什么不做，避免范围蔓延": "本次不涉及", "可运行命令": "npx vitest run",
    "要证明什么": "契约断言通过", "原始输出 / 退出码": "37 passed, exit=0",
    "字段/行为": "couponId", "加字段 / 多版本 / 并行发版": "加字段",
    "路径）": "src/x.ts", "起来源": "x", "谁在调": "小程序",
}
for f in glob.glob(os.path.join(d, "*.md")) + glob.glob(os.path.join(d, "release", "*.md")):
    s = io.open(f, encoding="utf8").read()
    i = s.find("\n## ")
    if i < 0:
        continue
    head, body = s[:i+1], s[i+1:]
    for k, v in FIXED.items():
        body = body.replace(k, v)
    # 只替换**整格就是占位**的（`| （说明） |`），避免误伤正文
    body = re.sub(r"（([^（）]{1,40})）", lambda m: ALLOW.get(m.group(1), "已填实"), body)
    body = re.sub(r"\(([^()]{1,40})\)", lambda m: ALLOW.get(m.group(1), "已填实"), body)
    io.open(f, "w", encoding="utf8").write(head + body)
PYFILL
}

pass() { printf '  [OK] %s\n' "$1"; }
fail() { printf '  [NG] %s\n' "$1"; FAILED=1; }
FAILED=0

echo "== 0. 搭一个真实形态的 Maven 工程（非 Node 场景） =="
cat > pom.xml <<'EOS'
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId><artifactId>order-api</artifactId><version>1.0.0</version>
  <properties><maven.compiler.source>21</maven.compiler.source></properties>
</project>
EOS
cat > src/main/java/com/example/order/OrderDto.java <<'EOS'
package com.example.order;
public record OrderDto(String id, String status) {}
EOS
# 门禁脚本模拟 Maven 的输出形态（surefire 汇总行），不依赖真的装 Maven
cat > scripts/build.sh <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
echo "[INFO] Scanning for projects..."
echo "[INFO] BUILD SUCCESS"
EOS
cat > scripts/build-should-fail.sh <<'EOS'
#!/usr/bin/env bash
echo "[ERROR] COMPILATION ERROR" >&2
exit 1
EOS
cat > scripts/test.sh <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
echo "[INFO] Running com.example.order.OrderServiceTest"
echo "[INFO] Tests run: 12, Failures: 0, Errors: 0, Skipped: 0"
echo "[INFO] BUILD SUCCESS"
EOS
cat > scripts/test-should-fail.sh <<'EOS'
#!/usr/bin/env bash
echo "[ERROR] Tests run: 1, Failures: 1, Errors: 0" >&2
exit 1
EOS
chmod +x scripts/*.sh
pass "Maven 形态工程已就位：$P"

echo
echo "== 1. init：已有脚本不得被覆盖 =="
"$DEVFLOW" init --name order-api --kind service --stack java-maven >/tmp/jv-init.log 2>&1
grep -q "跳过" /tmp/jv-init.log && pass "已存在的 scripts 未被覆盖" || fail "init 覆盖了已有脚本"
# 把门禁换成 Java 形态
python3 - <<'EOS'
import json, io
p = "devflow.json"
d = json.load(io.open(p, encoding="utf8"))
d["devflow"]["stack"] = "java"
d["gates"] = {
  "build": {"run": "./scripts/build.sh", "negative_control": "./scripts/build-should-fail.sh"},
  "test": {"run": "./scripts/test.sh", "count_regex": "Tests run: (\\d+)", "require_min_tests": 1,
           "negative_control": "./scripts/test-should-fail.sh"},
}
io.open(p, "w", encoding="utf8").write(json.dumps(d, ensure_ascii=False, indent=2))
EOS

echo
echo "== 2. doctor：Maven 形态配置必须判为可以开工 =="
if "$DEVFLOW" doctor >/tmp/jv-doctor.log 2>&1; then
  pass "doctor 通过（$(grep -o '阻断 [0-9]* · 削弱 [0-9]*' /tmp/jv-doctor.log | head -1)）"
else
  fail "doctor 未通过"; sed -n '1,15p' /tmp/jv-doctor.log
fi

echo
echo "== 3. 微档：只留状态，门禁必须真跑 =="
"$DEVFLOW" new --slug typo --date 2026-01-01 --tier micro --title "修正日志文案" >/dev/null
if "$DEVFLOW" gate run 2026-01-01-typo >/tmp/jv-micro.log 2>&1; then
  grep -q "count=12" /tmp/jv-micro.log && pass "Maven surefire 计数被抓到（count=12）" || fail "未抓到 Tests run 计数"
else
  fail "微档门禁失败"; sed -n '1,15p' /tmp/jv-micro.log
fi

echo
echo "== 4. 轻档：跳过契约，一路走到 released =="
"$DEVFLOW" new --slug list-ui --date 2026-01-01 --tier light --title "列表加导出按钮" --surface ui >/dev/null
D=".devflow/items/2026-01-01-list-ui"
"$DEVFLOW" advance 2026-01-01-list-ui --to spec_ready >/dev/null; pass "-> spec_ready"
"$DEVFLOW" advance 2026-01-01-list-ui --to implementing >/dev/null; pass "-> implementing（轻档跳过契约）"
"$DEVFLOW" advance 2026-01-01-list-ui --to tested >/dev/null; pass "-> tested"
# 确认记录：占位内容不算证据 —— 先看引擎是否拦下，再按真实内容填写
if "$DEVFLOW" advance 2026-01-01-list-ui --to verified >/dev/null 2>&1; then
  fail "占位确认记录竟然允许推进到 verified（占位应不算证据）"
else
  pass "占位确认被拦下（占位内容不算证据）"
fi
grep -q "确认记录未填" <("$DEVFLOW" advance 2026-01-01-list-ui --to verified --check 2>&1) \
  && pass "预演点名了「确认记录未填」并给出填法" || fail "预演未点名确认记录问题"
cat > ".devflow/items/2026-01-01-list-ui/APPROVALS.md" <<'EOS'
# 确认记录 · 列表加导出按钮

## 确认记录

| 确认点 | 确认人 | 时间 | 结论 |
|---|---|---|---|
| 需求与判据 | 张三 | 2026-01-01T09:00:00Z | 通过 |
EOS
# 其余产物也必须填掉模板占位（占位内容不算证据，G1b 会拦）
cat > ".devflow/items/2026-01-01-list-ui/coding_report.md" <<'EOS'
# 实现报告 · 列表加导出按钮

## 改了什么

- src/main/java/com/example/order/ListToolbar.java：新增导出按钮

## 涉及提交

| 提交 | 仓库 | 说明 |
|---|---|---|
| a1b2c3d | order-api | 新增导出按钮 |
EOS
cat > ".devflow/items/2026-01-01-list-ui/verification.md" <<'EOS'
# 验证记录 · 列表加导出按钮

## 逐条对照

| AC | 结论 | 证据 |
|---|---|---|
| AC-1 | 已实现 | 命令 ./scripts/test.sh 退出码 0，Tests run: 12（见 STATUS.json） |

## 结论

- 总体结论：已实现
- 阻断项：无
- 基线豁免：无

## 证据

- 命令原文与输出尾部见 STATUS.json lastRun.records
EOS
cat > ".devflow/items/2026-01-01-list-ui/SPEC.md" <<'EOS'
# SPEC · 列表加导出按钮

## 身份

| 键 | 值 |
|---|---|
| item | 2026-01-01-list-ui |
| tier | light |
| owner | 张三 |
| repos | order-api |
| change_surface | ui |

## 验收标准

| AC | 判据 | 判据类型 | 责任方 |
|---|---|---|---|
| AC-1 | ./scripts/test.sh 退出码 0 且 Tests run ≥ 1 | 命令 | 实现者 |

## 不做什么

- 不改后端接口
EOS
if "$DEVFLOW" advance 2026-01-01-list-ui --to verified >/dev/null 2>&1; then
  pass "-> verified（占位全部填实后通过）"
else
  fail "verified 失败：占位未被识别或被误拦"
  "$DEVFLOW" gate run 2026-01-01-list-ui --to verified 2>&1 | grep -E "G1b|结论" | head -3
fi
# 发布报告由 fill 按模板补齐（先看预演给出的缺口，再补）
"$DEVFLOW" advance 2026-01-01-list-ui --to released --check >/tmp/jv-pre.log 2>&1 || true
grep -q "release/report.md" /tmp/jv-pre.log && pass "预演点出了缺失的发布报告" || fail "预演未点出缺发布报告"
if "$DEVFLOW" advance 2026-01-01-list-ui --to released >/dev/null 2>&1; then
  fail "缺发布报告竟然可以推进"
else
  "$DEVFLOW" fill 2026-01-01-list-ui --to released >/tmp/jv-fill.log 2>&1
  grep -q "release/report.md" /tmp/jv-fill.log && pass "fill 按模板补齐了发布报告" || fail "fill 未补齐"
fi
# fill 生成的是**模板**（含占位）；产物必须填实才算证据 —— 这里模拟采用者的实际动作。
fill_item "$P/.devflow/items/2026-01-01-list-ui"
# 显示失败原因（不要用 >/dev/null + set -e 静默退出：那样只看到"卡住"，看不到原因）
if "$DEVFLOW" advance 2026-01-01-list-ui --to released >/dev/null 2>&1; then
  pass "-> released"
else
  fail "-> released 失败"; echo "  WORKDIR=$PWD"; "$DEVFLOW" advance 2026-01-01-list-ui --to released --check 2>&1 | tail -20
fi

echo
echo "== 5. 标准档：跳过契约状态时不得被索要 CONTRACT.md =="
"$DEVFLOW" new --slug feature --date 2026-01-01 --tier standard --title "订单状态流转" --surface interface >/dev/null
D2=".devflow/items/2026-01-01-feature"
# 标准档会生成 CONTRACT.md 模板；删掉它，然后跳过 contracted 直接推进
rm -f "$D2/CONTRACT.md"
if "$DEVFLOW" advance 2026-01-01-feature --to spec_ready >/dev/null 2>&1 &&
   "$DEVFLOW" advance 2026-01-01-feature --to implementing >/dev/null 2>&1; then
  pass "标准档跳过契约成功（不需要 CONTRACT.md）"
else
  fail "标准档跳过契约被拒"; "$DEVFLOW" advance 2026-01-01-feature --to implementing --check 2>&1 | tail -6
fi

echo
echo "== 6. 重档：必须被索要契约 =="
"$DEVFLOW" new --slug crossrepo --date 2026-01-01 --tier heavy --title "跨仓契约变更" --repos order-api,web-pc --surface contract >/dev/null
D3=".devflow/items/2026-01-01-crossrepo"
rm -f "$D3/CONTRACT.md"
"$DEVFLOW" advance 2026-01-01-crossrepo --to spec_ready >/dev/null 2>&1
if "$DEVFLOW" advance 2026-01-01-crossrepo --to implementing --check >/tmp/jv-heavy.log 2>&1; then
  fail "重档缺少契约竟然可以推进"
else
  grep -q "CONTRACT.md" /tmp/jv-heavy.log && pass "重档被索要 CONTRACT.md（预演拦下）" || fail "重档未点名缺契约"
fi

echo
echo "== 7. 归档：默认空跑不改动任何文件 =="
BEFORE=$(find . -type f | wc -l | tr -d ' ')
"$DEVFLOW" archive >/tmp/jv-archive.log 2>&1
AFTER=$(find . -type f | wc -l | tr -d ' ')
[ "$BEFORE" = "$AFTER" ] && pass "归档空跑零副作用（文件数 $BEFORE 未变）" || fail "归档空跑改动了文件"

echo
echo "== 8. 看板：可生成、只读 =="
"$DEVFLOW" report >/dev/null && test -s .devflow/board.html && pass "看板已生成" || fail "看板未生成"
rm -rf "$(dirname "$P")"

echo
if [ "$FAILED" -eq 0 ]; then
  printf 'Java 场景验收通过\n'
else
  printf 'Java 场景验收失败\n'; exit 1
fi

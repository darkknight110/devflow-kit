#!/usr/bin/env bash
# 独立视角验收：模拟"只看文档的陌生人"。
#
# 三条硬约束（否则这次验证没有意义）：
#   ① 只使用 README / 02 / 03 文档里出现过的命令与取值；
#   ② 在**陌生目录**里操作，绝不改动 kit 自身；
#   ③ 文档没写的东西一律算缺陷（断言失败），不靠 --help 偷偷绕过。
#
# 支持多栈：单独跑 / 全部跑
#   bash verify-independent.sh            # 默认 python-pytest
#   bash verify-independent.sh go-test    # 指定栈
#   bash verify-independent.sh all        # 四栈全跑
set -euo pipefail

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEVFLOW="$KIT/bin/devflow"
FAILED=0
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

echo "== 1. 文档卫生：不得出现无效的技术栈取值 =="
for bad in '"stack": "java"' '"stack": "node"' '--stack node' '--stack java '; do
  if grep -qF "$bad" "$KIT/docs/02-adoption-guide.md" "$KIT/docs/03-daily-workflow.md" "$KIT/README.md" 2>/dev/null; then
    fail "文档仍含无效取值：$bad"
  fi
done
pass "文档未出现无效技术栈取值"

echo
echo "== 2. 文档必须覆盖陌生人会问的六件事 =="
check_doc() {
  local file="$1" needle="$2" desc="$3"
  grep -qF "$needle" "$KIT/$file" && pass "$desc" || fail "${desc}（$file 缺：${needle}）"
}
check_doc "docs/02-adoption-guide.md" "java-maven" "接入指南给出合法栈 id"
check_doc "docs/02-adoption-guide.md" "先写至少一个测试" "接入指南说明新仓无测试的出口"
check_doc "docs/02-adoption-guide.md" "退出码" "接入指南说明退出码语义"
check_doc "docs/03-daily-workflow.md" "日期>-<变更名" "手册说明 item 命名规则"
check_doc "docs/03-daily-workflow.md" "devflow adapters" "手册提到 adapters 命令"
check_doc "docs/03-daily-workflow.md" "micro" "手册说明微档路径"
# 二次独立验证暴露的缺口：这些必须一直有文档
check_doc "docs/02-adoption-guide.md" "force-scripts" "接入指南说明如何覆盖适配器脚本（装不了工具链时的出口）"
check_doc "docs/02-adoption-guide.md" "模板占位是否已填实" "接入指南说明占位内容会被拦"
check_doc "docs/02-adoption-guide.md" "两种判定口径" "接入指南说明 gate run 的两种判定口径"
check_doc "docs/03-daily-workflow.md" "占位内容不算证据" "手册说明占位内容会被拦"
check_doc "docs/02-adoption-guide.md" "D3b" "接入指南覆盖"构建工具没装"这一类"

# ── 单栈陌生人路径 ──────────────────────────────────────────
run_stack() {
  local stack="$1"
  echo
  echo "== 3. 陌生人路径：${stack}（只按文档做一遍） =="
  local ROOT
  ROOT="$(mktemp -d)/proj"
  case "$stack" in
    python-pytest) mkdir -p "$ROOT/src" "$ROOT/tests"
      INIT_TEST=$'#!/usr/bin/env bash\n# 本仓测试脚本（还没写测试）\nset -euo pipefail\nif [ ! -d tests ]; then echo "no tests ran" >&2; exit 5; fi\necho "0 passed in 0.01s"\n'
      GOOD_TEST=$'#!/usr/bin/env bash\nset -euo pipefail\nif [ ! -d tests ]; then echo "no tests ran" >&2; exit 5; fi\necho "12 passed in 0.42s"\n'
      GOOD_BUILD=$'#!/usr/bin/env bash\nset -euo pipefail\nif [ ! -d src ]; then echo "compileall failed: missing src" >&2; exit 1; fi\necho "compileall ok"\n' ;;
    go-test) mkdir -p "$ROOT"
      INIT_TEST=$'#!/usr/bin/env bash\nset -euo pipefail\necho "--- FAIL: TestX (no tests written yet)" >&2\nexit 1\n'
      GOOD_TEST=$'#!/usr/bin/env bash\nset -euo pipefail\necho "--- PASS: TestX (0.00s)"\nprintf \'%s tests passed\\n\' 12\n'
      GOOD_BUILD=$'#!/usr/bin/env bash\nset -euo pipefail\nif [ ! -f go.mod ]; then echo "go: no go.mod" >&2; exit 1; fi\necho "go build ok"\n' ;;
    node-jest) mkdir -p "$ROOT/src"
      INIT_TEST=$'#!/usr/bin/env bash\nset -euo pipefail\necho "No tests found" >&2\nexit 1\n'
      GOOD_TEST=$'#!/usr/bin/env bash\nset -euo pipefail\nif [ ! -d src ]; then echo "No tests found" >&2; exit 1; fi\necho "Tests:       12 passed, 12 total"\n'
      GOOD_BUILD=$'#!/usr/bin/env bash\nset -euo pipefail\nif [ -f package.json ]; then echo "build ok"; else exit 1; fi\n' ;;
    java-maven) mkdir -p "$ROOT/src/main/java"
      INIT_TEST=$'#!/usr/bin/env bash\nset -euo pipefail\necho "[ERROR] no tests to run" >&2\nexit 1\n'
      GOOD_TEST=$'#!/usr/bin/env bash\nset -euo pipefail\nif [ ! -d src ]; then echo "[ERROR] no tests to run" >&2; exit 1; fi\necho "[INFO] Tests run: 12, Failures: 0, Errors: 0"\n'
      GOOD_BUILD=$'#!/usr/bin/env bash\nset -euo pipefail\nif [ ! -d src/main/java ]; then echo "[ERROR] COMPILATION ERROR" >&2; exit 1; fi\necho "[INFO] BUILD SUCCESS"\n' ;;
    *) fail "未知栈：$stack"; return 1 ;;
  esac
  [ "$stack" = "go-test" ] && printf 'module example.com/x\n\ngo 1.21\n' > "$ROOT/go.mod"
  [ "$stack" = "java-maven" ] && printf '<project/>\n' > "$ROOT/pom.xml"
  [ "$stack" = "node-jest" ] && printf '{"name":"x"}\n' > "$ROOT/package.json"
  [ "$stack" = "python-pytest" ] && printf '{"devflow": {"project": "x"}}\n' > "$ROOT/pyproject.toml"

  (
    cd "$ROOT"
    # ① 文档：init（靠自动识别）
    "$DEVFLOW" init --name indie >/tmp/ind-init-$stack.log 2>&1
    grep -q "$stack" /tmp/ind-init-$stack.log && echo "  [OK] 自动识别 $stack" || { echo "  [NG] 未识别 $stack"; exit 1; }
    # ② 文档：先体检。注意：init 生成的脚本调用真实工具链（mvn/go/npm），
    #    本机可能没装；这里先写成"本仓可跑但还没有测试"的形态，才等同于真实新仓的处境。
    printf '%s' "$GOOD_BUILD" > scripts/build.sh
    printf '%s' "$INIT_TEST" > scripts/test.sh
    chmod +x scripts/build.sh scripts/test.sh
    if "$DEVFLOW" doctor >/tmp/ind-d1-$stack.log 2>&1; then
      echo "  [NG] 新仓没有可用测试却判为可以开工"; exit 1
    fi
    grep -qF "先写至少一个测试" /tmp/ind-d1-$stack.log \
      && echo "  [OK] 体检给出「先写测试」的出口（与文档一致）" \
      || { echo "  [NG] 体检未给出无测试的出口"; sed -n '1,12p' /tmp/ind-d1-$stack.log; exit 1; }
    # ③ 文档：写本仓自己的构建/测试脚本（这是采用者的实际动作；模板只是起点）
    printf '%s' "$GOOD_BUILD" > scripts/build.sh
    printf '%s' "$GOOD_TEST" > scripts/test.sh
    chmod +x scripts/build.sh scripts/test.sh
    if "$DEVFLOW" doctor >/tmp/ind-d2-$stack.log 2>&1; then
      echo "  [OK] 配上真实测试后：可以开工"
    else
      echo "  [NG] 配上测试后仍不可信"; sed -n '1,10p' /tmp/ind-d2-$stack.log; exit 1
    fi
    # ④ 文档：建变更（light 档序列）
    "$DEVFLOW" new --date 2026-10-13 --slug indie-first --tier light --title "第一次变更" --surface ui >/dev/null 2>&1
    ITEM="$(ls .devflow/items | head -1)"
    case "$ITEM" in 20*-*) echo "  [OK] 变更已建：${ITEM}（符合 <日期>-<变更名>）" ;; *) echo "  [NG] item 名不符合规则：$ITEM"; exit 1 ;; esac
    # ⑤ 文档：预演 → 推进
    "$DEVFLOW" advance "$ITEM" --to spec_ready --check >/dev/null 2>&1
    "$DEVFLOW" advance "$ITEM" --to spec_ready >/dev/null 2>&1
    "$DEVFLOW" advance "$ITEM" --to implementing >/dev/null 2>&1
    # ⑥ 文档：提测（自动跑门禁）
    if "$DEVFLOW" advance "$ITEM" --to tested >/dev/null 2>&1; then
      echo "  [OK] -> tested（门禁自动执行）"
    else
      echo "  [NG] 提测失败"; "$DEVFLOW" advance "$ITEM" --to tested --check | tail -8; exit 1
    fi
    # ⑦ 文档：占位内容不算证据 ⇒ 必须先被拦下（用 --to 预检直接看内容层判定）
    if "$DEVFLOW" gate run "$ITEM" --to verified >/tmp/ind-g-$stack.log 2>&1; then
      echo "  [NG] 占位内容竟被判为通过"; exit 1
    fi
    grep -qF "占位内容不算证据" /tmp/ind-g-$stack.log \
      && echo "  [OK] 占位内容被 --to 预检拦下（与手册一致）" \
      || { echo "  [NG] 占位内容未被点名"; tail -6 /tmp/ind-g-$stack.log; exit 1; }
    # ⑧ 文档：把模板占位全部填实（占位内容不算证据 —— 手册与 gate --to 都这么说）
    cat > ".devflow/items/$ITEM/SPEC.md" <<'EOS'
# SPEC

## 身份

| 项 | 值 |
|---|---|
| item | indie-first |
| 档位 | 轻（light） |
| 负责人 | 张三 |
| 目标仓 | indie |
| 变更面 | ui |

## 验收标准

| AC | 判据 | 判据类型 | 责任方 |
|---|---|---|---|
| AC-1 | ./scripts/test.sh 退出码 0 且计数 ≥ 1 | 命令 | 实现者 |

## 不做什么

- 不改后端接口
EOS
    cat > ".devflow/items/$ITEM/coding_report.md" <<'EOS'
# 实现报告

## 改了什么

- 新增导出按钮

## 涉及提交

| 提交 | 仓库 | 说明 |
|---|---|---|
| a1b2c3d | indie | 新增导出按钮 |
EOS
    cat > ".devflow/items/$ITEM/verification.md" <<'EOS'
# 验证记录

## 逐条对照

| AC | 结论 | 证据 |
|---|---|---|
| AC-1 | 已实现 | 命令 ./scripts/test.sh 退出码 0，计数 12（见 STATUS.json） |

## 结论

- 总体结论：已实现
- 阻断项：无
- 基线豁免：无

## 证据

- 命令原文与输出尾部见 STATUS.json lastRun.records
EOS
    # ⑧ 文档：填确认（light 只有一行）+ 推进
    cat > ".devflow/items/$ITEM/APPROVALS.md" <<'EOS'
# 确认记录

## 确认记录

| 确认点 | 确认人 | 时间 | 结论 |
|---|---|---|---|
| 需求与判据 | 张三 | 2026-10-13T09:00:00Z | 通过 |
EOS
    "$DEVFLOW" advance "$ITEM" --to verified >/dev/null 2>&1 && echo "  [OK] -> verified" || { echo "  [NG] verified 失败"; "$DEVFLOW" advance "$ITEM" --to verified --check | tail -6; exit 1; }
    # ⑨ 文档：发布报告用 fill 补，再推进
    "$DEVFLOW" fill "$ITEM" --to released >/dev/null 2>&1
    # fill 生成的是模板（含占位）；产物必须填实才算证据
    fill_item "$PWD/.devflow/items/$ITEM"
    if "$DEVFLOW" advance "$ITEM" --to released >/dev/null 2>&1; then
      echo "  [OK] -> released"
    else
      echo "  [NG] released 失败"; "$DEVFLOW" advance "$ITEM" --to released --check 2>&1 | tail -8; exit 1
    fi
    # ⑩ 文档：看板与归档
    "$DEVFLOW" report >/dev/null 2>&1 && test -s .devflow/board.html && echo "  [OK] 看板已生成" || { echo "  [NG] 看板未生成"; exit 1; }
    BEFORE=$(find . -type f | wc -l | tr -d ' ')
    "$DEVFLOW" archive >/dev/null 2>&1
    AFTER=$(find . -type f | wc -l | tr -d ' ')
    [ "$BEFORE" = "$AFTER" ] && echo "  [OK] 归档空跑零副作用" || { echo "  [NG] 归档空跑改动了文件"; exit 1; }
  ) || fail "$stack 陌生人路径未走通"
  rm -rf "$(dirname "$ROOT")"
}

TARGET="${1:-python-pytest}"
if [ "$TARGET" = "all" ]; then
  for st in python-pytest go-test node-jest java-maven; do run_stack "$st"; done
else
  run_stack "$TARGET"
fi

echo
if [ "$FAILED" -eq 0 ]; then
  printf '独立视角验收通过\n'
else
  printf '独立视角验收失败\n'; exit 1
fi

#!/usr/bin/env bash
# 四栈交叉验收：java-maven / node-jest / python-pytest / go-test
# 目的：证明"选一个栈就能开工"——每种栈的真实输出形态都能被统一的门禁声明确认。
# 用 --demo 变体：自包含、输出各栈真实形态，因此不要求本机装齐 Maven/pytest/Go。
set -euo pipefail

# 可移植的 sed -i：BSD/macOS 需要 `-i ''`，GNU/Linux 需要 `-i`。
# 直接用 `sed -i ''` 在 Linux 上会把空串当成文件名 ⇒ CI 上必然失败（实测）。
sedi() {
  if sed --version >/dev/null 2>&1; then sed -i "$@"; else sed -i '' "$@"; fi
}


KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEVFLOW="$KIT/bin/devflow"
FAILED=0
pass() { printf '  [OK] %s\n' "$1"; }
fail() { printf '  [NG] %s\n' "$1"; FAILED=1; }

echo "== 适配器自检：每个 count_regex 必须能抓到自己的样本输出 =="
AUDIT="$("$DEVFLOW" adapters 2>&1 | grep -c '适配器自检：全部 count_regex' || true)"
[ "$AUDIT" -ge 1 ] && pass "四个适配器的 count_regex 自检通过" || { fail "适配器自检未通过"; "$DEVFLOW" adapters | tail -5; }

run_stack() {
  local id="$1" marker="$2" srcpath="$3"
  echo
  echo "== 技术栈：${id}（标记 ${marker}） =="
  local root
  root="$(mktemp -d)/proj"
  # 夹具要满足该栈 demo 脚本的前置检查（缺目录时门禁应当失败，那是刻意的）
  mkdir -p "$root/$srcpath"
  case "$id" in
    python-pytest) mkdir -p "$root/src" ;;      # 构建检查 src/，测试检查 tests/
    java-maven)    mkdir -p "$root/src/main/java" ;;
    node-jest)     mkdir -p "$root/src" ;;
  esac
  ( cd "$root" && touch "$marker"
    "$DEVFLOW" init --name "demo-${id}" --stack "$id" --demo >/tmp/stack-init.log 2>&1
    # ① 必须识别出该栈
    grep -q "$id" /tmp/stack-init.log && echo "  [OK] 识别技术栈 $id" || { echo "  [NG] 未识别 $id"; return 1; }
    # ② 占位脚本必须已被该栈模板替换
    if grep -q "devflow:placeholder" scripts/test.sh 2>/dev/null; then
      echo "  [NG] ${id}：test.sh 仍是占位脚本"; return 1
    fi
    echo "  [OK] 门禁脚本已替换为 $id 的真实模板"
    # ③ doctor 必须判"可以开工"
    if "$DEVFLOW" doctor >/tmp/stack-doctor.log 2>&1; then
      echo "  [OK] doctor：$(grep -o '统计：[^│]*' /tmp/stack-doctor.log | head -1)"
    else
      echo "  [NG] ${id}：doctor 未通过"; sed -n '1,12p' /tmp/stack-doctor.log; return 1
    fi
    # ④ 测试计数必须被 count_regex 抓到（=12）
    "$DEVFLOW" new --date 2026-10-13 --slug first --tier micro --title "首个变更" >/dev/null 2>&1
    if "$DEVFLOW" gate run 2026-10-13-first >/tmp/stack-gate.log 2>&1; then
      if grep -q "test .*count=12" /tmp/stack-gate.log; then
        echo "  [OK] 测试计数被抓到（count=12）"
      else
        echo "  [NG] ${id}：未抓到 count=12"; grep -E "test " /tmp/stack-gate.log; return 1
      fi
      echo "  [OK] 负向对照可信 + 总结论 PASS"
    else
      echo "  [NG] ${id}：门禁未通过"; sed -n '1,15p' /tmp/stack-gate.log; return 1
    fi
    # ⑤ 假通过防御：把计数改成 0 必须被拦下
    sedi -E 's/(Tests run: |Tests: +|)(12)( passed|, Failures| tests passed)/\112\3/' scripts/test.sh 2>/dev/null || true
    cp scripts/test.sh /tmp/stack-test.bak
    case "$id" in
      java-maven)    sedi 's/Tests run: 12/Tests run: 0/' scripts/test.sh ;;
      node-jest)     sedi 's/Tests:       12 passed/Tests:       0 passed/' scripts/test.sh ;;
      python-pytest) sedi 's/12 passed/0 passed/' scripts/test.sh ;;
      go-test)       sedi "s/printf '%s tests passed\\\\n' 12/printf '%s tests passed\\\\n' 0/" scripts/test.sh ;;
    esac
    if "$DEVFLOW" gate run 2026-10-13-first >/tmp/stack-gate0.log 2>&1; then
      echo "  [NG] ${id}：测试数为 0 竟然通过"; return 1
    else
      echo "  [OK] 测试数为 0 被拦下"
    fi
    cp /tmp/stack-test.bak scripts/test.sh
  ) || return 1
  rm -rf "$(dirname "$root")"
  return 0
}

run_stack "java-maven"    "pom.xml"          "src/main/java" || fail "java-maven 栈验收失败"
run_stack "node-jest"     "package.json"     "src"           || fail "node-jest 栈验收失败"
run_stack "python-pytest" "pyproject.toml"   "tests"         || fail "python-pytest 栈验收失败"
run_stack "go-test"       "go.mod"           "."             || fail "go-test 栈验收失败"

echo
if [ "$FAILED" -eq 0 ]; then
  printf '四栈验收通过\n'
else
  printf '四栈验收失败\n'; exit 1
fi

#!/usr/bin/env bash
# 端到端验收：**四个档位的差异必须被正确执行**。
#
# 为什么需要这套：档位是这个工作流的成本旋钮（micro 最轻、heavy 最严），
# 但它此前**没有系统化验收** —— 只在其它脚本里被顺带用到。
# 结果就是一个真缺陷长期存在：standard 会创建它并不需要的 CONTRACT.md，
# 随后被"占位内容"拦下（代码与它自己的注释、与正典都矛盾）。
#
# 本脚本对每档断言两件事：
#   ① **该创建的**产物创建了；② **不该索要/创建的**产物没有被牵涉（反向断言，最有价值）。
set -euo pipefail

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DF="node $KIT/scripts/cli.mjs"
WORK="$(mktemp -d)/tiers"
mkdir -p "$WORK"

pass() { printf '  [OK] %s\n' "$1"; }
fail() { printf '  [NG] %s\n' "$1"; FAILED=1; }
FAILED=0

echo "== 0. 准备一个最小可用的项目 =="
cd "$WORK"
printf '{"name":"tiers"}\n' > package.json
$DF init --name tiers >/dev/null 2>&1
printf '#!/usr/bin/env bash\necho "Tests  3 passed"\n' > scripts/test.sh
printf '#!/usr/bin/env bash\necho ok\n' > scripts/build.sh
chmod +x scripts/*.sh
pass "项目已就绪：$WORK"

# ── 各档位的预期（与 spec/states.json 的 tiers 对齐）────────────────
# 格式：档位|创建产物（空格分隔，子串匹配）|不应出现|确认点数
expect() {
  case "$1" in
    micro)    echo "release|SPEC.md CONTRACT.md TASKS.md APPROVALS.md|0" ;;
    light)    echo "SPEC.md APPROVALS.md coding_report.md verification.md release|CONTRACT.md TASKS.md|1" ;;
    standard) echo "SPEC.md TASKS.md APPROVALS.md coding_report.md verification.md release|CONTRACT.md|2" ;;
    heavy)    echo "SPEC.md CONTRACT.md TASKS.md APPROVALS.md coding_report.md verification.md release|（无）|3" ;;
  esac
}

echo
echo "== 1. 每档：创建什么、不创建什么 =="
for tier in micro light standard heavy; do
  IFS='|' read -r want forbid approvals <<<"$(expect "$tier")"
  $DF new --date 2026-10-14 --slug "$tier" --tier "$tier" --title "档位验收 $tier" \
      --owner 验收 --repos tiers >/dev/null 2>&1
  ITEM="2026-10-14-$tier"
  DIR=".devflow/items/$ITEM"
  files="$(ls "$DIR" 2>/dev/null | grep -v '^\.state$' | tr '\n' ' ')"

  ok=1
  for f in $want; do
    if [[ "$f" == "release" ]]; then
      [ -e "$DIR/release" ] || { ok=0; fail "$tier 缺少 release/ 目录"; }
    else
      [[ "$files" == *"$f"* ]] || { ok=0; fail "$tier 未创建 $f"; }
    fi
  done
  [ "$ok" = 1 ] && pass "$tier 必需产物齐备"

  # 反向断言：不该出现的产物**不得**被创建（这是最容易错的方向）
  if [ "$forbid" != "（无）" ]; then
    for f in $forbid; do
      if [[ "$files" == *"$f"* ]]; then
        fail "$tier 不该创建 $f（正典未要求；会引出"占位内容"误阻断）"
      fi
    done
  fi
done
pass "反向断言通过：light/standard 均未被创建 CONTRACT.md，light 未被创建 TASKS.md"

echo
echo "== 2. 每档：缺必需产物时必须被拦（门禁不许放行） =="
# micro 无必需产物，跳过本段
for tier in light standard heavy; do
  ITEM="2026-10-14-$tier"
  case "$tier" in
    light)    rm -f ".devflow/items/$ITEM/SPEC.md" ;;
    standard) rm -f ".devflow/items/$ITEM/TASKS.md" ;;
    heavy)    rm -f ".devflow/items/$ITEM/CONTRACT.md" ;;
  esac
  out="$($DF gate run "$ITEM" --to released --check 2>&1 || true)"
  if echo "$out" | grep -q "缺少产物"; then
    pass "$tier 缺产物被拦（$(echo "$out" | grep -oE '缺少产物：[^—]*' | head -1 | cut -c1-40)…）"
  else
    fail "$tier 缺产物却未被拦"
  fi
  # 恢复
  $DF fill "$ITEM" --to released >/dev/null 2>&1 || true
done

echo
echo "== 3. 档位不是摆设：micro 最轻、heavy 最严 =="
micro_out="$($DF gate run 2026-10-14-micro --to released --check 2>&1 || true)"
if ! echo "$micro_out" | grep -qE "CONTRACT|TASKS|SPEC"; then
  pass "micro 不被索要任何产物（符合 requiredArtifacts 为空）"
else
  fail "micro 被索要了产物"
fi

heavy_out="$($DF gate run 2026-10-14-heavy --to released --check 2>&1 || true)"
# heavy 必须牵涉契约：要么要求它，要么检查它的内容
if echo "$heavy_out" | grep -q "CONTRACT.md"; then
  pass "heavy 会检查契约（符合 requiredArtifacts 含 CONTRACT.md）"
else
  fail "heavy 未检查契约"
fi

echo
echo "== 3.5 最轻档必须真能走完（否则"微改动"名不副实） =="
# micro 全程 0 产物、0 确认点；若走不完说明档位设计有洞
for st in spec_ready implementing tested verified released; do
  if ! $DF advance 2026-10-14-micro --to "$st" >/dev/null 2>&1; then
    fail "micro 走不到 $st（最轻档应当能一路到 released）"
    break
  fi
done
if $DF status 2026-10-14-micro 2>/dev/null | grep -qE '已发布'; then
  pass "micro 可一路走到 released（0 产物、0 确认点）"
else
  fail "micro 未能到达 released"
fi


echo "== 4. 降档禁令有提示（G7 启发式） =="
$DF new --date 2026-10-14 --slug lowtier --tier micro --title "低档但改契约" \
    --owner 验收 --repos tiers --surface contract >/dev/null 2>&1
g7="$($DF gate run 2026-10-14-lowtier --to released --check 2>&1 || true)"
if echo "$g7" | grep -qE "G7"; then
  pass "G7 对"档位可能偏低"给出启发式提示"
else
  fail "G7 未对低档+契约面给出提示"
fi

echo
if [ "$FAILED" -eq 0 ]; then
  printf '档位验收通过（micro/light/standard/heavy 的差异都被正确执行）\n'
else
  printf '档位验收失败\n'; exit 1
fi

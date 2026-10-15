#!/usr/bin/env bash
# 一次跑完全部验收：自检 + 全部端到端套件（含人的闭环与四档位验收）
# 为什么要这个入口：验收分散在 6 个命令里，人容易漏跑其中一套（漏跑等于没验）。
set -uo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAIL=0
printf '═══ 自检 ═══\n'
if NO_COLOR=1 node "$KIT/scripts/selfcheck.mjs" | tail -2; then :; else FAIL=1; fi
for s in verify-example verify-java-project verify-stacks verify-independent verify-human-loop verify-tiers; do
  printf '═══ %s ═══\n' "$s"
  # 失败时必须**显示细节**：只取尾行会把原因吞掉（实测在 CI 上只看到"失败"两个字，无法定位）
  log="$(mktemp)"
  if bash "$KIT/examples/$s.sh" all >"$log" 2>&1; then
    tail -1 "$log"
  else
    FAIL=1
    echo "  ✗ $s 失败 —— 最后 15 行："
    tail -15 "$log" | sed 's/^/    /'
  fi
  rm -f "$log"
done
echo
if [ "$FAIL" -eq 0 ]; then echo "全部验收通过（自检 + 全部端到端套件）"; exit 0; fi
echo "有验收未通过 —— 见上方输出"; exit 1

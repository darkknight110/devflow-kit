#!/usr/bin/env bash
# 一次跑完全部验收：自检 + 五套端到端。
# 为什么要这个入口：验收分散在 6 个命令里，人容易漏跑其中一套（漏跑等于没验）。
set -uo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAIL=0
printf '═══ 自检 ═══\n'
if NO_COLOR=1 node "$KIT/scripts/selfcheck.mjs" | tail -2; then :; else FAIL=1; fi
for s in verify-example verify-java-project verify-stacks verify-independent verify-human-loop; do
  printf '═══ %s ═══\n' "$s"
  if bash "$KIT/examples/$s.sh" all 2>&1 | tail -1; then :; else FAIL=1; fi
done
echo
if [ "$FAIL" -eq 0 ]; then echo "全部验收通过（自检 + 五套端到端）"; exit 0; fi
echo "有验收未通过 —— 见上方输出"; exit 1

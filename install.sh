#!/bin/sh
# devflow-kit 一行安装：克隆到 ~/.devflow-kit，链接到 ~/.local/bin。
#
#   curl -fsSL https://raw.githubusercontent.com/darkknight110/devflow-kit/main/install.sh | sh
#
# 设计约束（与产品一致：不静默、不乱写）：
#   · 不用 sudo；所有写入都在 $HOME 下；
#   · 已存在则只做快进更新，不覆盖本地改动（ff-only 失败就停下来说明原因）；
#   · 链接失败不报死：打印手动 PATH 方案，安装本身仍算成功。
set -eu

REPO="${DEVFLOW_REPO:-https://github.com/darkknight110/devflow-kit.git}"
DEST="${DEVFLOW_HOME:-$HOME/.devflow-kit}"
BIN="${DEVFLOW_BIN:-$HOME/.local/bin}"

info() { printf '  %s\n' "$*"; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || fail "需要 git（未安装）"
command -v node >/dev/null 2>&1 || fail "需要 Node.js ≥ 18（未安装）"
node -e 'const m=process.versions.node.match(/^(\d+)/); if(Number(m[1])<18){console.error("Node "+process.versions.node+" 太旧，需要 ≥18");process.exit(1)}' \
  || fail "Node.js 版本过低（需要 ≥18）"

printf 'devflow-kit · 安装\n'

if [ -d "$DEST/.git" ]; then
  info "已存在：$DEST（尝试快进更新）"
  if ! git -C "$DEST" pull --ff-only --quiet; then
    info "跳过更新：本地有未提交改动或分叉（不影响已安装版本）"
  fi
else
  info "克隆到：$DEST"
  git clone --depth 1 --quiet "$REPO" "$DEST" || fail "克隆失败（检查网络或仓库地址）"
fi

[ -x "$DEST/bin/devflow" ] || fail "安装不完整：缺少 bin/devflow"

mkdir -p "$BIN"
if ln -sf "$DEST/bin/devflow" "$BIN/devflow" 2>/dev/null; then
  info "已链接：$BIN/devflow"
else
  info "无法创建链接，请手动加别名：alias devflow=\"$DEST/bin/devflow\""
fi

printf '\n装好了。下一步：\n'
info "1) devflow --version"
info "2) 在项目里：devflow init --with-preflight（可选）"
info "3) devflow doctor"
printf '\n'
case ":$PATH:" in
  *":$BIN:"*) ;;
  *) info "提示：$BIN 不在 PATH 里，把下面一行加进 ~/.zshrc："
     info "  export PATH=\"$BIN:\$PATH\"" ;;
esac

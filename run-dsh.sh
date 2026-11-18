#!/bin/zsh
# 在实验目录里启动无界面 dsh。密钥和 dsh 命令都不写死本机路径。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
export DSH_HOME="${DSH_HOME:-$ROOT/.dsh-home}"

if [[ -z "${DEEPSEEK_API_KEY:-}" && -f "$ROOT/.deepseek-key" ]]; then
  export DEEPSEEK_API_KEY="$(<"$ROOT/.deepseek-key")"
fi
if [[ -z "${DEEPSEEK_API_KEY:-}" ]]; then
  echo "需要环境变量 DEEPSEEK_API_KEY，或把密钥放在 $ROOT/.deepseek-key" >&2
  exit 1
fi

if [[ -n "${DSH_BIN:-}" ]]; then
  DSH="$DSH_BIN"
elif command -v dsh >/dev/null 2>&1; then
  DSH="$(command -v dsh)"
else
  echo "找不到 dsh。请先安装 DeepSeek Harness，或设置 DSH_BIN。" >&2
  exit 1
fi

cd "$ROOT"
exec "$DSH" --patch "$ROOT/model.patch.yml" --profile headless --permission-mode workspace-write "$@"

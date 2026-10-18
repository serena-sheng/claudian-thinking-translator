#!/usr/bin/env bash
# 把仓库里的插件文件同步到 Obsidian 库
set -euo pipefail

VAULT="${VAULT:-$HOME/Library/Mobile Documents/com~apple~CloudDocs/Serena-heart}"
DEST="$VAULT/.obsidian/plugins/claudian-thinking-translator"

if [ ! -d "$VAULT/.obsidian" ]; then
  echo "找不到 Obsidian 库：$VAULT" >&2
  echo "用法：VAULT=/path/to/vault ./install.sh" >&2
  exit 1
fi

mkdir -p "$DEST"
cp main.js manifest.json styles.css "$DEST/"
echo "已同步到：$DEST"
echo "在 Obsidian 里重载插件（或重启）后生效。"

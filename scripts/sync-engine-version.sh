#!/usr/bin/env bash
# ====================================================================
# 同步引擎版本号到前端所有入口
#   1. 从 wasm/pikafish.wasm 里读取日期（如 20260619）。
#   2. 追加当前 UTC 时间，生成唯一 ENGINE_VERSION（如 20260619-143052）。
#   3. 把 wasm/js 复制到 xqwlight/wasm/。
#   4. 更新 sw.js / pikafish.html / pikafish-engine.js 里的
#      ENGINE_VERSION，确保用户每次访问都拿到最新构建。
# ====================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

WASM="$ROOT/wasm/pikafish.wasm"
JS="$ROOT/wasm/pikafish.js"
RELAXED_WASM="$ROOT/wasm/pikafish.relaxed.wasm"
RELAXED_JS="$ROOT/wasm/pikafish.relaxed.js"

if [ ! -f "$WASM" ] || [ ! -f "$JS" ]; then
  echo "错误：找不到 $WASM 或 $JS" >&2
  exit 1
fi

# 从 wasm 字符串里提取日期（如 20260619）
WASM_DATE=$(strings "$WASM" | grep -oE '20[0-9]{6}' | head -n 1 || true)
if [ -z "$WASM_DATE" ]; then
  echo "错误：无法从 wasm 中提取日期" >&2
  exit 1
fi

# 用当前 UTC 时间保证每次 workflow 运行的版本号唯一
BUILD_TIME=$(date -u +'%H%M%S')
ENGINE_VERSION="${WASM_DATE}-${BUILD_TIME}"

echo "同步引擎版本: $ENGINE_VERSION"

# 复制到 xqwlight 部署目录（含 relaxed 和非 relaxed 两个变体）
mkdir -p "$ROOT/xqwlight/wasm"
cp "$JS"           "$ROOT/xqwlight/wasm/pikafish.js"
cp "$WASM"         "$ROOT/xqwlight/wasm/pikafish.wasm"
if [ -f "$RELAXED_JS" ]; then
  cp "$RELAXED_JS" "$ROOT/xqwlight/wasm/pikafish.relaxed.js"
fi
if [ -f "$RELAXED_WASM" ]; then
  cp "$RELAXED_WASM" "$ROOT/xqwlight/wasm/pikafish.relaxed.wasm"
fi

# 更新所有前端文件里的 ENGINE_VERSION
FILES=(
  "$ROOT/sw.js"
  "$ROOT/xqwlight/sw.js"
  "$ROOT/xqwlight/pikafish.html"
  "$ROOT/xqwlight/pikafish-engine.js"
)

for f in "${FILES[@]}"; do
  if [ -f "$f" ]; then
    sed -i -E "s/(ENGINE_VERSION\s*=\s*\")[^\"]+(\";)/\1${ENGINE_VERSION}\2/" "$f"
    echo "已更新: $f"
  else
    echo "警告：文件不存在 $f" >&2
  fi
done

echo "完成"
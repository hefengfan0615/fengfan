#!/bin/sh

fetch_network() {
  _filename="pikafish.nnue"
  _repo_cache="../xqwlight/wasm/$_filename"

  # 1. 从仓库获取 NNUE 权重（由手动管理，不自动下载）
  if [ -f "$_repo_cache" ]; then
    echo "Found $_filename in repo, reusing"
    cp "$_repo_cache" "$_filename"
    return
  fi

  # 2. 本地已有则跳过
  if [ -f "$_filename" ]; then
    echo "Exists $_filename, skipping"
    return
  fi

  # 3. 仓库和本地都没有 → 报错退出
  >&2 printf "%s\n" "ERROR: $_filename not found in repo or locally." \
    "Please place the NNUE weights file at xqwlight/wasm/$_filename"
  exit 1
}

$call fetch_network
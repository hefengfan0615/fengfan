#!/bin/sh

# download commands with a 5min time-out to ensure things fail if the server stalls
wget_or_curl=$( (command -v wget >/dev/null 2>&1 && echo "wget -qO- --timeout=300 --tries=1") ||
  (command -v curl >/dev/null 2>&1 && echo "curl -skL --max-time 300"))

fetch_network() {
  _filename="pikafish.nnue"
  _repo_file="../xqwlight/wasm/$_filename"

  # 1. 优先从仓库获取已缓存的 NNUE 数据（超级压缩后的权重文件）
  if [ -f "$_repo_file" ]; then
    echo "Found $_filename in repo (xqwlight/wasm/), using cached data"
    cp "$_repo_file" "$_filename"
    return
  fi

  # 2. 本地已有则跳过
  if [ -f "$_filename" ]; then
    echo "Exists $_filename, skipping download"
    return
  fi

  # 3. 仓库没有本地也没有，从网络下载
  if [ -z "$wget_or_curl" ]; then
    >&2 printf "%s\n" "Neither wget or curl is installed." \
      "Install one of these tools to download NNUE files automatically."
    exit 1
  fi

  url="https://github.com/official-pikafish/Networks/releases/download/master-net/$_filename"
    echo "Downloading from $url (no cached data in repo) ..."
    if $wget_or_curl "$url" > "$_filename"; then
      echo "Successfully downloaded $_filename"
    else
      # Download was not successful, return false.
      rm -f $_filename
      echo "Failed to download $_filename from $url"
      return 1
    fi
}

$call fetch_network
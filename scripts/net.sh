#!/bin/sh

wget_or_curl=$( (command -v wget > /dev/null 2>&1 && echo "wget -qO-") || \
                (command -v curl > /dev/null 2>&1 && echo "curl -skL"))

fetch_network() {
  _filename="pikafish.nnue"

  if [ -f "$_filename" ]; then
    echo "Exists $_filename, skipping download"
    return
  fi

  if [ -z "$wget_or_curl" ]; then
    >&2 printf "%s\n" "Neither wget or curl is installed." \
          "Install one of these tools to download NNUE files automatically."
    exit 1
  fi

  _download_url="https://github.com/official-pikafish/Networks/releases/download/master-net/pikafish.nnue"

  echo "Downloading $_filename from $_download_url ..."
  if $wget_or_curl "$_download_url" > "$_filename" && [ -s "$_filename" ]; then
    echo "Successfully downloaded $_filename"
  else
    echo "Failed to download $_filename from $_download_url"
    return 1
  fi
}

$call fetch_network
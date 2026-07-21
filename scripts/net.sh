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

  _archive_url="https://github.com/official-pikafish/Pikafish/releases/download/Pikafish-2026-01-02/Pikafish.2026-01-02.7z"
  _archive_file="Pikafish.2026-01-02.7z"

  echo "Downloading $_filename from $_archive_url ..."
  if $wget_or_curl "$_archive_url" > "$_archive_file" && [ -s "$_archive_file" ]; then
    echo "Successfully downloaded archive"
  else
    echo "Failed to download archive from $_archive_url"
    return 1
  fi

  # Extract pikafish.nnue from the 7z archive
  if command -v 7z > /dev/null 2>&1; then
    7z e "$_archive_file" "$_filename" -y > /dev/null 2>&1
  elif command -v 7za > /dev/null 2>&1; then
    7za e "$_archive_file" "$_filename" -y > /dev/null 2>&1
  elif command -v 7zr > /dev/null 2>&1; then
    7zr e "$_archive_file" "$_filename" -y > /dev/null 2>&1
  else
    echo "7z not found, installing p7zip..."
    if command -v apt-get > /dev/null 2>&1; then
      sudo apt-get update -qq && sudo apt-get install -y -qq p7zip-full > /dev/null 2>&1
    elif command -v brew > /dev/null 2>&1; then
      brew install p7zip > /dev/null 2>&1
    else
      >&2 echo "Cannot install 7z. Please install p7zip-full manually."
      rm -f "$_archive_file"
      return 1
    fi
    7z e "$_archive_file" "$_filename" -y > /dev/null 2>&1
  fi

  if [ -f "$_filename" ]; then
    echo "Successfully extracted $_filename"
    rm -f "$_archive_file"
  else
    echo "Failed to extract $_filename from archive"
    rm -f "$_archive_file"
    return 1
  fi
}

$call fetch_network
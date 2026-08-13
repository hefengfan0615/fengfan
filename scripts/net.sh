#!/bin/sh

fetch_network() {
  _filename="pikafish.nnue"

  if [ -f "$_filename" ]; then
    echo "Exists $_filename, skipping"
    return
  fi

  _repo_nnue="../xqwlight/wasm/pikafish.nnue"

  if [ -f "$_repo_nnue" ]; then
    echo "Copying $_filename from $_repo_nnue ..."
    cp "$_repo_nnue" "$_filename"
    echo "Done"
  else
    echo "NNUE file not found at $_repo_nnue"
    return 1
  fi
}

$call fetch_network
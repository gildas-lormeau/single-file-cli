#!/bin/sh

deno compile --allow-read --allow-write --allow-net --allow-env --allow-run --ext=js --output=./dist/single-file-aarch64-apple-darwin --target=aarch64-apple-darwin ./single-file
deno compile --allow-read --allow-write --allow-net --allow-env --allow-run --ext=js --output=./dist/single-file-x86_64-apple-darwin --target=x86_64-apple-darwin ./single-file
deno compile --allow-read --allow-write --allow-net --allow-env --allow-run --ext=js --output=./dist/single-file-x86_64-linux --target=x86_64-unknown-linux-gnu ./single-file
deno compile --allow-read --allow-write --allow-net --allow-env --allow-run --ext=js --output=./dist/single-file-aarch64-linux --target=aarch64-unknown-linux-gnu ./single-file
deno compile --allow-read --allow-write --allow-net --allow-env --allow-run --ext=js --output=./dist/single-file.exe --target=x86_64-pc-windows-msvc ./single-file
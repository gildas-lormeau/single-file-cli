#!/bin/sh

npm install
npm update

npx rollup -c rollup.config.dev.js
deno run --allow-read scripts/build-resources-script.js > lib/single-file-bundle.js

find lib -type f ! -name 'single-file-bundle.js' -delete

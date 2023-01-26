#!/bin/sh

sudo apt install zip jq

npm install
npm update

npx rollup -c rollup.config.js
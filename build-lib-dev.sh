#!/bin/sh

npm install
npm update

npx rollup -c rollup.config.dev.js
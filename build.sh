#!/usr/bin/env bash

set -e

CORE_PACKAGE="npm:single-file-core@1.5.124"
ESBUILD_PACKAGE="npm:esbuild@0.27.7"
WEB_STREAMS_PACKAGE="npm:web-streams-polyfill@4.3.0"

project_dir=$(pwd)
build_dir=$(mktemp -d)
trap 'rm -rf "$build_dir"' EXIT

cd "$build_dir"
deno install --vendor --quiet --minimum-dependency-age=0 "$CORE_PACKAGE" "$WEB_STREAMS_PACKAGE"

echo "
import { build } from '$ESBUILD_PACKAGE';

const core = '$build_dir/node_modules/single-file-core';
const lib = '$project_dir/lib';

await build({
  entryPoints: [
    core + '/single-file.js'
  ],
  bundle: true,
  globalName: 'singlefile',
  outdir: lib,
  platform: 'browser',
  sourcemap: false,
  minify: true,
  format: 'iife',
  plugins: [],
});

await build({
  entryPoints: [
    core + '/single-file-bootstrap.js'
  ],
  bundle: true,
  globalName: 'singlefileBootstrap',
  outdir: lib,
  platform: 'browser',
  sourcemap: false,
  minify: true,
  format: 'iife',
  plugins: [],
});

await build({
  entryPoints: [
    core + '/single-file-hooks-frames.js'
  ],
  bundle: true,
  outdir: lib,
  platform: 'browser',
  sourcemap: false,
  minify: true,
  format: 'iife',
  plugins: [],
});

await build({
  entryPoints: [
    core + '/vendor/zip/zip.min.js'
  ],
  bundle: true,
  globalName: 'zip',
  outdir: lib,
  platform: 'browser',
  sourcemap: false,
  minify: true,
  format: 'iife',
  plugins: [],
});

await build({
  entryPoints: [
    core + '/single-file-archive.js'
  ],
  bundle: true,
  outfile: lib + '/single-file-archive.js',
  platform: 'neutral',
  sourcemap: false,
  minify: true,
  format: 'esm',
  plugins: [],
});

const SCRIPTS = [
	lib + '/single-file.js',
	lib + '/single-file-bootstrap.js',
	lib + '/zip.min.js'
];

let script = '';
const scripts = SCRIPTS.map(script => Deno.readTextFile(script));
const sources = await Promise.all(scripts);
script += 'const script = ' + JSON.stringify(sources.join(';')) + ';';
const hookScript = await Deno.readTextFile(lib + '/single-file-hooks-frames.js');
script += 'const hookScript = ' + JSON.stringify(hookScript) + ';';
const zipScript = await Deno.readTextFile(lib + '/zip.min.js');
script += 'const zipScript = ' + JSON.stringify(zipScript) + ';';
const webStreamsPonyfill = await Deno.readTextFile('$build_dir/node_modules/web-streams-polyfill/dist/ponyfill.js');
script += 'const webStreamsPonyfill = ' + JSON.stringify(webStreamsPonyfill) + ';';
script += 'export { script, zipScript, hookScript, webStreamsPonyfill };';
await Deno.writeTextFile(lib + '/single-file-bundle.js', script)
await Promise.all(SCRIPTS.map(script => Deno.remove(script)));
await Deno.remove(lib + '/single-file-hooks-frames.js');
const version = JSON.parse(await Deno.readTextFile('$project_dir/deno.json')).version;
await Deno.writeTextFile(lib + '/version.js', 'export const version = ' + JSON.stringify(version) + ';');
" |  deno run --allow-read --allow-write --allow-net --allow-run --allow-env --lock="$build_dir/build.lock" -

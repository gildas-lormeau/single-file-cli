#!/usr/bin/env bash

set -e

ESBUILD_PACKAGE="npm:esbuild@0.27.7"

build_dir=$(mktemp -d)
trap 'rm -rf "$build_dir"' EXIT

echo "
import { build } from '$ESBUILD_PACKAGE';

await build({
  entryPoints: [
    '../single-file-core/single-file.js'
  ],
  bundle: true,
  globalName: 'singlefile',
  outdir: 'lib-dev/',
  platform: 'browser',
  sourcemap: false,
  minify: false,
  format: 'iife',
  plugins: [],
});

await build({
  entryPoints: [
    '../single-file-core/single-file-bootstrap.js'
  ],
  bundle: true,
  globalName: 'singlefileBootstrap',
  outdir: 'lib-dev/',
  platform: 'browser',
  sourcemap: false,
  minify: false,
  format: 'iife',
  plugins: [],
});

await build({
  entryPoints: [
    '../single-file-core/single-file-hooks-frames.js'
  ],
  bundle: true,
  outdir: 'lib-dev/',
  platform: 'browser',
  sourcemap: false,
  minify: false,
  format: 'iife',
  plugins: [],
});

await build({
  entryPoints: [
    '../single-file-core/vendor/zip/zip.min.js'
  ],
  bundle: true,
  globalName: 'zip',
  outdir: 'lib-dev/',
  platform: 'browser',
  sourcemap: false,
  minify: false,
  format: 'iife',
  plugins: [],
});

await build({
  entryPoints: [
    '../single-file-core/single-file-archive.js'
  ],
  bundle: true,
  outfile: 'lib-dev/single-file-archive.js',
  platform: 'neutral',
  sourcemap: false,
  minify: false,
  format: 'esm',
  plugins: [],
});

const SCRIPTS = [
	'lib-dev/single-file.js',
	'lib-dev/single-file-bootstrap.js',
	'lib-dev/zip.min.js'
];

let script = '';
const scripts = SCRIPTS.map(script => Deno.readTextFile(script));
const sources = await Promise.all(scripts);
script += 'const script = ' + JSON.stringify(sources.join(';')) + ';';
const hookScript = await Deno.readTextFile('lib-dev/single-file-hooks-frames.js');
script += 'const hookScript = ' + JSON.stringify(hookScript) + ';';
const zipScript = await Deno.readTextFile('lib-dev/zip.min.js');
script += 'const zipScript = ' + JSON.stringify(zipScript) + ';';
script += 'export { script, zipScript, hookScript };';
await Deno.writeTextFile('lib-dev/single-file-bundle.js', script)
await Promise.all(SCRIPTS.map(script => Deno.remove(script)));
await Deno.remove('lib-dev/single-file-hooks-frames.js');
const version = JSON.parse(await Deno.readTextFile('./deno.json')).version;
await Deno.writeTextFile('lib-dev/version.js', 'export const version = ' + JSON.stringify(version) + ';');
" |  deno run --allow-read --allow-write --allow-net --allow-run --allow-env --lock="$build_dir/build.lock" -

# Stage a runnable tree in .dev/, with the freshly built artifacts overlaid on the hand-written
# files from lib/. Generated code never lands in the tracked lib/ directory, so a dev build cannot
# leave an unminified bundle where the release one belongs, and using the dev build is something you
# opt into by invoking .dev/single-file rather than something you get by forgetting to rebuild.
rm -rf .dev
mkdir -p .dev
cp ./single-file ./single-file-launcher.js ./single-file-cli-api.js ./options.js ./deno.json ./package.json .dev/
cp -R ./resources .dev/resources
cp -R ./lib .dev/lib
cp lib-dev/* .dev/lib/

core_revision=$(git -C ../single-file-core rev-parse --short HEAD 2>/dev/null || echo "unknown")
if [ -n "$(git -C ../single-file-core status --porcelain 2>/dev/null | head -1)" ]; then
	core_revision="$core_revision+uncommitted"
fi

echo
echo "Dev build ready: single-file-core $core_revision"
echo "  run it with:  node .dev/single-file <url> <output>"
echo "  tracked lib/ is untouched; .dev/ and lib-dev/ are git-ignored"
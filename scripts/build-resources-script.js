/* global Deno, URL */

const SCRIPTS = [
	"lib/single-file.js",
	"lib/single-file-bootstrap.js",
	"lib/single-file-hooks-frames.js",
	"lib/single-file-zip.min.js"
];

const scripts = SCRIPTS.map(script => Deno.readTextFile(new URL("../" + script, import.meta.url)));
const sources = await Promise.all(scripts);
console.log("const script = " + JSON.stringify(sources.join(";\n")) + ";\n"); // eslint-disable-line no-console
const zipScript = await Deno.readTextFile(new URL("../lib/single-file-zip.min.js", import.meta.url));
console.log("const zipScript = " + JSON.stringify(zipScript) + ";"); // eslint-disable-line no-console
console.log("export { script, zipScript };"); // eslint-disable-line no-console
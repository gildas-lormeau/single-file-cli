// Which directory the e2e tests spawn the CLI from decides what they actually prove. By default it
// is the repository root, which runs the committed lib/ — a build of the *pinned npm release* of
// single-file-core. So after fixing something in a local single-file-core checkout, a green suite
// here says nothing about the fix: the tests never loaded that code.
//
// SINGLE_FILE_TARGET=dev points them at .dev/ instead, the tree build-dev.sh stages from
// ../single-file-core. Same suite, same assertions, against the unreleased core:
//
//   ./build-dev.sh && npm run test:dev
//
// The missing-directory check is deliberately loud. A silent fallback to the repository root would
// reintroduce exactly the failure this exists to prevent — tests passing against the wrong code.
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import process from "node:process";

const repositoryDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
const useDevBuild = process.env.SINGLE_FILE_TARGET === "dev";
const cliDirectory = useDevBuild ? join(repositoryDirectory, ".dev") : repositoryDirectory;

if (useDevBuild && !existsSync(join(cliDirectory, "lib", "single-file-bundle.js"))) {
	throw new Error("SINGLE_FILE_TARGET=dev is set but .dev/ holds no build — run ./build-dev.sh first");
}

// Unit tests import generated modules directly. They have to go through here too, or they keep
// testing the released build while the e2e tests exercise the dev one.
function importLibModule(name) {
	return import(join(cliDirectory, "lib", name));
}

export { cliDirectory, repositoryDirectory, useDevBuild, importLibModule };

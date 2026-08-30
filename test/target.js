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
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync, statSync } from "node:fs";
import process from "node:process";

const CORE_DIRECTORY_NAME = "single-file-core";
// what a rebuild does not read cannot make the build stale
const IGNORED_DIRECTORY_NAMES = ["node_modules", "test", "tmp", "dist", "doc"];

const repositoryDirectory = join(dirname(fileURLToPath(import.meta.url)), "..");
const useDevBuild = process.env.SINGLE_FILE_TARGET === "dev";
const cliDirectory = useDevBuild ? join(repositoryDirectory, ".dev") : repositoryDirectory;

if (useDevBuild) {
	const bundlePath = join(cliDirectory, "lib", "single-file-bundle.js");
	if (!existsSync(bundlePath)) {
		throw new Error("SINGLE_FILE_TARGET=dev is set but .dev/ holds no build — run ./build-dev.sh first");
	}
	checkDevBuildIsCurrent(bundlePath);
}

// A dev build is a snapshot and nothing invalidates it: edit single-file-core, forget to rebuild,
// and the suite runs the previous code while reporting on the current one. That failure is silent,
// and worse, it reads as good news — every variant of an experiment comes out identical, which
// looks exactly like "the change has no effect". It has already cost a full round of measurements.
// Comparing the newest core source against the bundle turns it into a refusal to start.
function checkDevBuildIsCurrent(bundlePath) {
	const coreDirectory = join(repositoryDirectory, "..", CORE_DIRECTORY_NAME);
	if (!existsSync(coreDirectory)) {
		return;
	}
	const newest = getNewestSource(coreDirectory);
	if (newest && newest.time > statSync(bundlePath).mtimeMs) {
		throw new Error("the .dev/ build is older than " + join(CORE_DIRECTORY_NAME, relative(coreDirectory, newest.path)) +
			" — run ./build-dev.sh, or the suite measures the previous core and reports it as the current one");
	}
}

function getNewestSource(directory, newest) {
	readdirSync(directory, { withFileTypes: true }).forEach(entry => {
		if (entry.name.startsWith(".")) {
			return;
		}
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (!IGNORED_DIRECTORY_NAMES.includes(entry.name)) {
				newest = getNewestSource(path, newest);
			}
		} else if (entry.name.endsWith(".js") || entry.name.endsWith(".json")) {
			const time = statSync(path).mtimeMs;
			if (!newest || time > newest.time) {
				newest = { path, time };
			}
		}
	});
	return newest;
}

// Unit tests import generated modules directly. They have to go through here too, or they keep
// testing the released build while the e2e tests exercise the dev one.
function importLibModule(name) {
	return import(join(cliDirectory, "lib", name));
}

export { cliDirectory, repositoryDirectory, useDevBuild, importLibModule };

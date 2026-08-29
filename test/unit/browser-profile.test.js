import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyProfile, pruneProfile } from "../../lib/browser.js";

async function createProfileDirectory() {
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	const sourcePath = join(directory, "profile");
	await mkdir(join(sourcePath, "Default", "Cache"), { recursive: true });
	await mkdir(join(sourcePath, "Default", "Local Storage"), { recursive: true });
	await mkdir(join(sourcePath, "GPUCache"), { recursive: true });
	await writeFile(join(sourcePath, "Local State"), "state");
	await writeFile(join(sourcePath, "Default", "Cookies"), "cookies");
	await writeFile(join(sourcePath, "Default", "Cache", "data_0"), "cached");
	await writeFile(join(sourcePath, "Default", "Local Storage", "leveldb"), "storage");
	await writeFile(join(sourcePath, "GPUCache", "index"), "cached");
	await symlink("hostname-1234", join(sourcePath, "SingletonLock"));
	return { directory, sourcePath, destinationPath: join(directory, "copy") };
}

test("copying a profile keeps the session data", async () => {
	const { directory, sourcePath, destinationPath } = await createProfileDirectory();
	try {
		await mkdir(destinationPath);
		await copyProfile(sourcePath, destinationPath);
		assert.equal(await readFile(join(destinationPath, "Local State"), "utf8"), "state");
		assert.equal(await readFile(join(destinationPath, "Default", "Cookies"), "utf8"), "cookies");
		assert.equal(await readFile(join(destinationPath, "Default", "Local Storage", "leveldb"), "utf8"), "storage");
	} finally {
		await rm(directory, { recursive: true });
	}
});

test("copying a profile skips caches and lock files", async () => {
	const { directory, sourcePath, destinationPath } = await createProfileDirectory();
	try {
		await mkdir(destinationPath);
		await copyProfile(sourcePath, destinationPath);
		assert.deepEqual((await readdir(destinationPath)).sort(), ["Default", "Local State"]);
		assert.deepEqual((await readdir(join(destinationPath, "Default"))).sort(), ["Cookies", "Local Storage"]);
	} finally {
		await rm(directory, { recursive: true });
	}
});

test("copying a profile leaves the source directory unmodified", async () => {
	const { directory, sourcePath, destinationPath } = await createProfileDirectory();
	try {
		await mkdir(destinationPath);
		await copyProfile(sourcePath, destinationPath);
		assert.deepEqual((await readdir(sourcePath)).sort(), ["Default", "GPUCache", "Local State", "SingletonLock"]);
		assert.deepEqual((await readdir(join(sourcePath, "Default"))).sort(), ["Cache", "Cookies", "Local Storage"]);
	} finally {
		await rm(directory, { recursive: true });
	}
});

test("pruning a profile deletes the caches at every depth", async () => {
	const { directory, sourcePath } = await createProfileDirectory();
	try {
		await pruneProfile(sourcePath);
		assert.deepEqual((await readdir(sourcePath)).sort(), ["Default", "Local State", "SingletonLock"]);
		assert.deepEqual((await readdir(join(sourcePath, "Default"))).sort(), ["Cookies", "Local Storage"]);
	} finally {
		await rm(directory, { recursive: true });
	}
});

test("pruning a profile keeps the session data", async () => {
	const { directory, sourcePath } = await createProfileDirectory();
	try {
		await pruneProfile(sourcePath);
		assert.equal(await readFile(join(sourcePath, "Local State"), "utf8"), "state");
		assert.equal(await readFile(join(sourcePath, "Default", "Cookies"), "utf8"), "cookies");
		assert.equal(await readFile(join(sourcePath, "Default", "Local Storage", "leveldb"), "utf8"), "storage");
	} finally {
		await rm(directory, { recursive: true });
	}
});

test("pruning a profile leaves nothing a copy would have taken", async () => {
	const { directory, sourcePath, destinationPath } = await createProfileDirectory();
	try {
		await mkdir(destinationPath);
		await copyProfile(sourcePath, destinationPath);
		await pruneProfile(sourcePath);
		const prunedEntries = (await readdir(sourcePath, { recursive: true })).sort();
		const copiedEntries = (await readdir(destinationPath, { recursive: true })).sort();
		assert.deepEqual(prunedEntries.filter(entry => entry != "SingletonLock"), copiedEntries);
	} finally {
		await rm(directory, { recursive: true });
	}
});

test("copying a missing profile is reported with its path", async () => {
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const missingPath = join(directory, "missing");
		await assert.rejects(
			() => copyProfile(missingPath, directory),
			error => error.message == `The browser profile directory was not found at ${JSON.stringify(missingPath)}`);
	} finally {
		await rm(directory, { recursive: true });
	}
});

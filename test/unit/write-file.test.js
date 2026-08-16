import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deno } from "../../lib/deno-polyfill.js";

const { writeTextFile, writeFile, readTextFile, errors } = Deno;

test("exclusive creation fails when the file exists", async () => {
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const filename = join(directory, "out.txt");
		await writeTextFile(filename, "first", { createNew: true });
		await assert.rejects(
			() => writeTextFile(filename, "second", { createNew: true }),
			error => error instanceof errors.AlreadyExists);
		await assert.rejects(
			() => writeFile(filename, new Uint8Array([1]), { createNew: true }),
			error => error instanceof errors.AlreadyExists);
		assert.equal(await readTextFile(filename), "first");
	} finally {
		await rm(directory, { recursive: true });
	}
});

test("writing without exclusive creation overwrites", async () => {
	const directory = await mkdtemp(join(tmpdir(), "single-file-test-"));
	try {
		const filename = join(directory, "out.txt");
		await writeTextFile(filename, "first");
		await writeTextFile(filename, "second");
		assert.equal(await readTextFile(filename), "second");
	} finally {
		await rm(directory, { recursive: true });
	}
});

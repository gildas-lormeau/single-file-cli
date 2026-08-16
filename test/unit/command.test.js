/* global setTimeout, clearTimeout */

import { test } from "node:test";
import assert from "node:assert/strict";
import process from "node:process";
import { Deno } from "../../lib/deno-polyfill.js";

const { Command } = Deno;

test("status resolves when the process exits with a nonzero code", async () => {
	const command = new Command(process.execPath, { args: ["-e", "process.exit(7)"] });
	const child = await command.spawn();
	const status = await child.status;
	assert.equal(status.code, 7);
});

test("status resolves when the process is killed", async () => {
	const command = new Command(process.execPath, { args: ["-e", "setTimeout(() => {}, 60000)"] });
	const child = await command.spawn();
	child.kill();
	const status = await child.status;
	assert.equal(status.code, null);
});

test("a process writing large output with discarded stdio exits", async () => {
	const script = "const chunk = \"x\".repeat(65536); for (let i = 0; i < 64; i++) { process.stdout.write(chunk); process.stderr.write(chunk); }";
	const command = new Command(process.execPath, { args: ["-e", script], stdout: "null", stderr: "null" });
	const child = await command.spawn();
	let timeoutId;
	const result = await Promise.race([
		child.status,
		new Promise(resolve => timeoutId = setTimeout(() => resolve("timeout"), 5000))
	]);
	clearTimeout(timeoutId);
	if (result === "timeout") {
		child.kill();
		await child.status.catch(() => { });
		assert.fail("process blocked on unread output");
	}
	assert.equal(result.code, 0);
});

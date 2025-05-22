import {
    assert,
    assertEquals,
    assertExists,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";

// Use deno run for cross-platform consistency, especially if single-file is a shell script.
const SINGLE_FILE_CLI_CMD = ["deno", "run", "-A", "./single-file-node.js"]; 
const TEST_PAGE_URL = "./test_page.html"; // test_page.html is in the same directory as the test script

async function runCli(args = []) {
    const command = new Deno.Command(SINGLE_FILE_CLI_CMD[0], {
        args: [...SINGLE_FILE_CLI_CMD.slice(1), ...args],
        stdout: "piped",
        stderr: "piped",
    });
    const { code, stdout, stderr } = await command.output();
    const stdoutText = new TextDecoder().decode(stdout);
    const stderrText = new TextDecoder().decode(stderr);

    if (code !== 0) {
        console.error("CLI Error Output:", stderrText);
        console.error("CLI Stdout Output:", stdoutText);
    }
    
    return {
        code,
        stdout: stdoutText,
        stderr: stderrText,
        success: code === 0,
    };
}

async function checkFileMagicNumbers(filePath, expectedMagicNumbers) {
    const fileData = await Deno.readFile(filePath);
    const magicNumbersSlice = fileData.subarray(0, expectedMagicNumbers.length);
    assertEquals(Array.from(magicNumbersSlice), Array.from(expectedMagicNumbers));
}

Deno.test("Screenshot CLI Tests", async (t) => {
    const tempDir = await Deno.makeTempDir({ prefix: "singlefile_test_" });
    // testPagePath should be relative to the CWD where deno test is run (usually project root)
    const testPagePath = TEST_PAGE_URL; 

    await t.step("Basic JPEG screenshot output", async () => {
        const outputFilename = "test_output.jpg";
        const outputPath = join(tempDir, outputFilename);
        const result = await runCli([
            testPagePath,
            "--output-format", "jpeg",
            "--output", outputPath,
            // Potentially add browser args if headless is not default or if specific ones are needed
            // e.g. "--browser-args=--headless=new" (or whatever single-file expects)
            // For now, relying on single-file's defaults or existing config for browser launching
        ]);

        assert(result.success, `CLI command failed: ${result.stderr}`);
        await assertExists(outputPath);
        const fileInfo = await Deno.stat(outputPath);
        assert(fileInfo.size > 0, "Output JPEG file should not be empty.");
        await checkFileMagicNumbers(outputPath, new Uint8Array([0xFF, 0xD8, 0xFF]));
        await Deno.remove(outputPath);
    });

    await t.step("Basic PNG screenshot output", async () => {
        const outputFilename = "test_output.png";
        const outputPath = join(tempDir, outputFilename);
        const result = await runCli([
            testPagePath,
            "--output-format", "png",
            "--output", outputPath,
        ]);

        assert(result.success, `CLI command failed: ${result.stderr}`);
        await assertExists(outputPath);
        const fileInfo = await Deno.stat(outputPath);
        assert(fileInfo.size > 0, "Output PNG file should not be empty.");
        await checkFileMagicNumbers(outputPath, new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
        await Deno.remove(outputPath);
    });
    
    await t.step("JPEG screenshot quality", async () => {
        const outputFilenameLow = "test_output_low_q.jpg";
        const outputPathLow = join(tempDir, outputFilenameLow);
        const outputFilenameHigh = "test_output_high_q.jpg";
        const outputPathHigh = join(tempDir, outputFilenameHigh);

        const resultLow = await runCli([
            testPagePath,
            "--output-format", "jpeg",
            "--screenshot-quality", "10",
            "--output", outputPathLow,
        ]);
        assert(resultLow.success, `CLI command failed for low quality: ${resultLow.stderr}`);
        await assertExists(outputPathLow);
        const fileInfoLow = await Deno.stat(outputPathLow);
        assert(fileInfoLow.size > 0, "Low quality JPEG should not be empty.");
        await checkFileMagicNumbers(outputPathLow, new Uint8Array([0xFF, 0xD8, 0xFF]));

        const resultHigh = await runCli([
            testPagePath,
            "--output-format", "jpeg",
            "--screenshot-quality", "90",
            "--output", outputPathHigh,
        ]);
        assert(resultHigh.success, `CLI command failed for high quality: ${resultHigh.stderr}`);
        await assertExists(outputPathHigh);
        const fileInfoHigh = await Deno.stat(outputPathHigh);
        assert(fileInfoHigh.size > 0, "High quality JPEG should not be empty.");
        await checkFileMagicNumbers(outputPathHigh, new Uint8Array([0xFF, 0xD8, 0xFF]));

        // Basic check: low quality should generally be smaller than high quality.
        // This might be flaky depending on the content and JPEG encoder specifics.
        assert(fileInfoLow.size < fileInfoHigh.size, `Low quality JPEG (size: ${fileInfoLow.size}) should ideally be smaller than high quality JPEG (size: ${fileInfoHigh.size}), but this might vary.`);

        await Deno.remove(outputPathLow);
        await Deno.remove(outputPathHigh);
    });

    await t.step("Screenshot full page vs. viewport", async () => {
        const outputFullPage = join(tempDir, "test_fullpage.png");
        const outputViewport = join(tempDir, "test_viewport.png");

        // Full page (default behavior)
        const resultFull = await runCli([
            testPagePath,
            "--output-format", "png",
            "--output", outputFullPage,
            "--browser-width=800", // Set a known width
            "--browser-height=600", // Set a known height, page is taller
        ]);
        assert(resultFull.success, `CLI command failed for full page: ${resultFull.stderr}`);
        await assertExists(outputFullPage);
        const fileInfoFull = await Deno.stat(outputFullPage);
        assert(fileInfoFull.size > 0, "Full page PNG should not be empty.");

        // Viewport only
        const resultViewport = await runCli([
            testPagePath,
            "--output-format", "png",
            "--output", outputViewport,
            "--screenshot-full-page=false",
            "--browser-width=800", 
            "--browser-height=600",
        ]);
        assert(resultViewport.success, `CLI command failed for viewport: ${resultViewport.stderr}`);
        await assertExists(outputViewport);
        const fileInfoViewport = await Deno.stat(outputViewport);
        assert(fileInfoViewport.size > 0, "Viewport PNG should not be empty.");
        
        // Viewport screenshot should be smaller than full-page screenshot for a tall page.
        assert(fileInfoViewport.size < fileInfoFull.size, `Viewport PNG (size: ${fileInfoViewport.size}) should be smaller than full page PNG (size: ${fileInfoFull.size}) for this test page.`);

        await Deno.remove(outputFullPage);
        await Deno.remove(outputViewport);
    });

    await t.step("Screenshot with clip", async () => {
        const outputFilename = "test_clip.png";
        const outputPath = join(tempDir, outputFilename);
        const clipRect = '{"x":10,"y":10,"width":100,"height":100}';

        const result = await runCli([
            testPagePath,
            "--output-format", "png",
            "--screenshot-clip", clipRect,
            "--output", outputPath,
        ]);

        assert(result.success, `CLI command failed for clipped screenshot: ${result.stderr}`);
        await assertExists(outputPath);
        const fileInfo = await Deno.stat(outputPath);
        assert(fileInfo.size > 0, "Clipped PNG should not be empty.");
        await checkFileMagicNumbers(outputPath, new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
        // Verifying dimensions programmatically would be ideal but requires an image lib.
        // For now, ensuring it runs and creates a valid PNG is the main check.
        await Deno.remove(outputPath);
    });

    await t.step("Screenshot filename generation (no --output)", async () => {
        // This test will create a file in the current directory of the test runner
        // It needs careful cleanup.
        const originalDirContents = [];
        for await (const dirEntry of Deno.readDir(".")) {
            originalDirContents.push(dirEntry.name);
        }

        const result = await runCli([
            testPagePath,
            "--output-format", "png",
            // No --output
        ]);
        assert(result.success, `CLI command failed for filename generation: ${result.stderr}`);

        let newFile = "";
        for await (const dirEntry of Deno.readDir(".")) {
            if (!originalDirContents.includes(dirEntry.name) && dirEntry.name.endsWith(".png")) {
                newFile = dirEntry.name;
                break;
            }
        }

        assert(newFile !== "", "No new PNG file found in current directory.");
        assert(newFile.includes("test_page") || newFile.includes("Screenshot_Test_Page"), "Filename does not seem to be based on title/URL.");
        // Check for date/time components is harder without knowing exact template format.
        // Example: "{page-title} ({date-locale} {time-locale}).{output-format}"
        // We can check if it ends with .png (already done by the loop condition)
        // and contains parts of the title.

        const fileInfo = await Deno.stat(newFile);
        assert(fileInfo.size > 0, "Generated PNG file should not be empty.");
        await checkFileMagicNumbers(newFile, new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
        
        if (newFile) {
            await Deno.remove(newFile);
        }
    });

    // Cleanup temp dir
    await Deno.remove(tempDir, { recursive: true });
});

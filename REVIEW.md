# Review checklist

Each item below starts with a trigger that can be read from a diff. When reviewing a change, check
only the items whose trigger matches. An item says what to check and why it exists. "CI" marks the
checks a workflow already enforces, the others rely on the reviewer.

## Generated files

- **`lib/single-file-bundle.js` or `lib/single-file-archive.js` changes.** They are built from the
  release of single-file-core pinned in `build.sh`, with `npm run update-core <version>`. A build
  made from a local checkout (`./build-dev.sh`, which writes to `.dev/`) must not be committed. CI
  ("Check lib/ matches the pinned core release").
- **The version changes.** `package.json`, `package-lock.json`, `deno.json` and `lib/version.js`
  change together. `lib/version.js` is generated from `deno.json` by the build, so the bump comes
  before the build. The publish workflow refuses a release where they disagree.

## Options

- **A new option.** It needs its entry in `options.js`, with a description that says what a user
  gets and what it costs. It works with both browser engines (`lib/cdp-client.js` for Chromium,
  `lib/bidi-client.js` for Firefox), or its description says which one it is limited to.
- **A new output path.** The tool never overwrites an existing file: a second capture into the same
  name is written beside it under another name.

## Browser launch

- **Code that launches a browser or connects to it** (`lib/chromium.js`, `lib/firefox.js`, the two
  clients). Several captures run at the same time on one machine. A process must only drive the
  browser it launched: `launchChromium` returns the URL of that browser, checked against its profile
  directory, and nothing else may be used to reach it. `test/e2e/parallel-captures.test.js` covers it.
- **The default of `--no-sandbox` changes, or the launch is changed.** On macOS and Windows the
  browser is launched with its sandbox, and again with `--no-sandbox` only when it exits at startup;
  the warning is displayed once the second launch has worked. On Linux `--no-sandbox` is a default:
  with the sandbox, a page that runs out of memory is not reported as crashed there (the reasons
  and the measurements are in `lib/chromium.js`). `test/e2e/sandbox-fallback.test.js` covers both,
  and the retry is only exercised on macOS: run it there before changing the launch.
- **A Chromium command line switch is added or removed.** Check `navigator.webdriver` and the user
  agent with `test/e2e/automation-detection.test.js`: some switches make pages see the capture as
  automated (`--remote-debugging-port=0` does).

## Tests

- **A new end-to-end test.** It spawns the tool from `cliDirectory` and passes `fastCaptureArgs`,
  both from `test/target.js`, so that the same test runs on the released bundle and on a development
  build (`SINGLE_FILE_TARGET=dev`). A test that only holds for one engine is skipped on the other
  with a reason (`skip: firefox && "..."`), and `npm run test:firefox` is run before the push.
- **A test of a fix made in single-file-core.** It fails on the pinned bundle until the core release
  is pinned here: it is committed with that update, and checked before with `./build-dev.sh` and
  `npm run test:dev`.
- **A test fails now and then.** It is not retried, skipped or given a delay. The cause is found:
  the failures seen in pairs for months were two processes sharing a debugging port, which also
  affected users.
- **A test passes on the first run.** Run it against the code without the fix as well.

## Code style

- **Any code change.** Tabs, double quotes, semicolons, `npm run lint` clean. CI ("Run linter").
- **Code in `lib/`, at the root or in `test/`.** Unlike single-file-core, this repository does carry
  comments: they say why the code is the way it is, with the measurement or the incident behind it.

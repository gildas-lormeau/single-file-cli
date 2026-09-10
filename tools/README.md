# tools

Development tools. Nothing here is shipped or imported by the CLI.

## `dump-dom.js`

Loads a page in Chromium and prints the DOM, and optionally a screenshot, once the page
has finished building itself.

```
node tools/dump-dom.js <url> [options]
```

| option | |
| --- | --- |
| `--wait-for <expression>` | dump when this JavaScript expression is truthy |
| `--stable-for <ms>` | otherwise, dump when the DOM has not changed for this long (default 1000) |
| `--timeout <ms>` | give up after this long (default 30000) |
| `--output <file>` | write the DOM to this file instead of stdout |
| `--screenshot <file>` | also write a PNG, and leave the DOM out of stdout |
| `--full-page` | capture the whole page instead of the viewport |
| `--browser-width <px>`, `--browser-height <px>` | viewport size |
| `--browser-executable-path <path>` | browser to run |
| `--show-browser` | run with a window instead of headless |

Exit status is 1 when the wait times out, with the condition and its last evaluated
value on stderr.

`--screenshot` waits on the same condition the DOM dump does, so it captures the page
the archive built rather than whatever was on screen at the load event. Pass `--output`
alongside it to get both; on its own it keeps stdout free for the PNG's sake. There is
no PDF: `--print-to-pdf` has no debugging use a screenshot does not cover.

### Why this exists

Chromium's own `--dump-dom` prints the DOM at the load event, which is too early for
any page that builds itself afterwards. A SingleFile archive is exactly that: it reads
its own bytes, unzips them and replaces the document, all after load. So `--dump-dom`
returns the wrapper, and the wrapper carries the title of the first page, which reads
like a plausible answer rather than an obvious failure.

Its siblings are no better, and each fails in a way that looks like a result. On a
three-page archive opened from `file:`, comparing the route holding the small table of
contents against the route holding a saved github.com page, every one of these exited 0:

| flag | table of contents route | github.com route |
| --- | --- | --- |
| `--dump-dom` | the wrapper | the wrapper |
| `--screenshot` | correct | a blank white PNG, 2727 bytes against 2728 for `about:blank` |
| `--print-to-pdf` | correct | an empty page whose header reads `Example Domain`, the wrapper's title |

`--screenshot` is the one to watch, because it fires late enough to be right whenever
the archive extracts quickly. That makes it look like it waits. It does not.

Chromium offers no "wait, then dump". The nearest thing, `--virtual-time-budget`, is a
fake clock rather than a wait: it fast-forwards the page's timers and stops when the
budget of *virtual* milliseconds is spent, whatever that costs in real time. It fails
in both directions on a real archive. Measured on a three-page archive opened from
`file:`, dumping the route that holds a saved github.com page:

| `--virtual-time-budget` | result |
| --- | --- |
| 100 to 800 | the wrapper, in about a second: the clock ran out before the archive finished extracting |
| 1000 | still running after 41s |
| 5000 | still running after 300s |

The page carries 1.75 MB of CSS and HTML and an animation that never ends, so it never
goes idle, and the clock is then spent one rendered frame at a time. This tool dumps
that same route in 2.4s.

### Choosing the wait

`--wait-for` is the reliable one, because it says what "done" means. Prefer it whenever
you know what the finished page looks like:

```
node tools/dump-dom.js "file:///tmp/archive.html#sfz/?toc" \
	--wait-for "document.querySelector('h1').textContent == 'Table of contents'"
```

The default, settling, is a heuristic for when you do not. It watches
`document.documentElement.outerHTML` and dumps once it has stopped changing, which
survives animation, because animation moves pixels rather than markup. What it cannot
survive is a gap: a page that sits still for longer than `--stable-for` and then
replaces itself dumps early, and an archive slow to extract is that page. Raise
`--stable-for` or use `--wait-for` when that matters.

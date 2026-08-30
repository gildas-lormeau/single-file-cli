# Fidelity harness

Renders a page, saves it, renders the save, and compares the pixels. The rest of the e2e suite
reads a capture as text or as bytes — a marker is present, an entry is named what it should be, the
console is clean. A save can pass all of that and still come back with its type in a fallback
family, its grid collapsed or a frame drawn blank.

The checks live in [`../e2e/fidelity.test.js`](../e2e/fidelity.test.js) and run with the rest of the
suite:

```
./build-dev.sh && npm run test:dev
```

`test:dev` is the form that matters here. The default target runs the committed `lib/`, a build of
the *pinned npm release* of single-file-core, so a green run says nothing about a local fix.

## What it can assert, and why

A page that does not render identically to **itself** cannot be held to rendering identically to its
save. Every check therefore captures the source twice first and uses the difference as its floor.
On these fixtures the floor is zero, which is why they are hand-built and static rather than
mirrored from the web — real pages reflow between two shots of the same file, and a suite built on
them reports noise as regression.

The comparison is done in the browser, on the two PNGs: Node has no image decoder, and adding one as
a dependency to compare pictures taken by a browser that already decodes PNG natively would be
paying twice for the same capability. Images are compared in horizontal bands so that a failure says
*where* the two renderings parted company, and a save shorter than its source counts its missing rows
as differing rather than having them cropped away.

Two things pixels cannot see, which are asserted on the saved markup instead:

- an `id` a script looks up or a `class` a selector matches, on an element the save replaced;
- pruning that did not happen. A build that gives up and keeps every font renders exactly like a
  correct one.

## The fixtures

Each is a defect that shipped, kept in the shape that made it visible, with a comment in the page
saying which.

| Fixture | What it holds |
|---|---|
| `duplicate-stylesheet/` | Two `<style>` elements with identical content. The archive writer folds them into one entry and points links at it; the element they were folded into kept its content inline as well, and the replacement dropped the attributes that identified it. |
| `linked-stylesheet/` | An external stylesheet linked with an id, a class, a data attribute and a title. A plain save has nowhere to put it, so the link becomes a style element — a new one, built from the media and the text and nothing else. |
| `used-fonts/` | Five declared faces, three drawn — named as a plain family, through a custom property declared on a descendant, and through the `font` shorthand. The minifier has stopped resolving each of those at some point. |
| `frame-fonts/` | A sandboxed frame declaring and using a face the page around it never names. Its `contentDocument` is out of reach, so it is re-parsed from its srcdoc and reports nothing about what it draws with. |
| `synthetic-italic/` | A face drawn in an italic it declares no face for, so the browser slants the upright one. Matching a loaded face against the computed style found nothing and pruned the family off the page that draws it. |
| `unresolved-font-property/` | A family named inside a property holding a whole font shorthand, declared twice so there is no single value to substitute. The stylesheets cannot name it; the rendered list can. |

`pages/fonts/` holds generated fonts in which every printable ASCII character is the same filled
rectangle: text set in them is a solid bar, so a face that goes missing is not a subtle reflow. The
three shapes differ, so keeping the *wrong* face is as visible as keeping none.
[`make-font.js`](make-font.js) writes them; run it after changing it, and commit the result.

## Rules the harness enforces, and what they cost to learn

Each of these is a way a run reported good news that was not true.

1. **A run without a noise floor concludes nothing.** Measured every time, never assumed.
2. **A whole-image verdict is not usable.** One line of reflow near the top moves every pixel below
   it, and a single number cannot tell a small local difference from a large one.
3. **A fixture that fails to load renders identically to itself.** The floor is zero, the save of
   that same failure matches it, and the check passes while testing nothing — it happened here, with
   a directory served as a file giving two beautifully identical 404 pages. The server records every
   miss and the checks refuse to conclude when there is one. Only the favicon is excused: a request
   to the captured site that the site cannot answer is a defect wherever it comes from, and this is
   how the archive writer was caught asking that site for a zip worker three times per save.
4. **The output file is removed before each save.** The default conflict action is to uniquify, so a
   second save writes `saved (2).html` and leaves the stale file where the test is looking.
5. **A stale dev build reads as "the change has no effect".** [`../target.js`](../target.js) refuses
   to start when `.dev/` is older than the newest source file in single-file-core.
6. **Assert on content, not on a number.** A five-megabyte cookie-consent wall looks exactly like a
   successful save.

## Adding a fixture

Build the page around the defect, in the shape that made it visible, and say in an HTML comment what
that was — the fixtures read as a record of what has gone wrong, which is most of their value once
the bug is a year old.

Then confirm the check can fail. Break the fix in single-file-core, rebuild, watch it go red, and
put it back. A check that passes against deliberately broken code is protecting nothing, and this is
not a formality here: `frame-fonts` found a defect on its first run that the commit it was written
to guard did not cover, `unresolved-font-property` had to be reshaped twice before it exercised the
code it names — a var() in family position resolves through the ordinary path, whatever it is nested
in — and `synthetic-italic` exists because a fixture that should have been unremarkable came back
with an empty list of used fonts.

Two traps worth knowing before writing one. A face used in a style the fonts do not declare is
drawn synthesized, which changes what the page reports about it; and a family name appears in the
declarations that *use* it as well as in the `@font-face` that declares it, so read the declared
faces out of the `@font-face` rules rather than searching the page for a name.

And commit the fix before mutating it. Restoring the tree between mutations is a `git checkout`,
which takes the uncommitted fix with it — the next mutation then fails to apply against code that
is already reverted, and reports a pass. It has happened twice here.

# The capture manifest

`single-file <url> page.html --manifest` writes `page.html.manifest.json` next to the saved page. The manifest records what SingleFile observed while saving: the resources the page fetched and what it did with them, the requests the browser made with their redirects and response hashes, the TLS sessions and certificates of the servers, the capture options, the environment, and the hash of the saved file. It is meant for someone who has to establish later what was captured, from where, and when.

This document describes format version 1, written by single-file-cli 2.18.0 and later.

## How to read it

The manifest is one JSON object written in canonical form ([RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)): keys sorted, no whitespace, no `undefined` values. Re-serializing the parsed object the same way yields the same bytes, so a hash or a signature of the file can be checked against the content. The `canonicalize` function in `lib/manifest.js` produces that form.

Three layers wrote it, and they saw different things. `producer` and `output` are written by the CLI itself.

- The page layer (`subject`, `time`, `environment`, `options`, `frames`) runs inside the page being saved. It knows which resources the document references and what it did with each, and it hashes the bytes it received. It does not see the network: a resource served from the browser cache looks the same as one fetched from the server.
- The network layer (`transport`) listens to the browser's own network events. It sees every request the browser sent, the redirects it followed, the server addresses and the TLS details when the engine exposes them, and it hashes the response bodies as the browser handed them back. It does not know what the page did with a response.
- `crossChecks` joins the two by URL and hash. `coverage` states which parts of the network layer were available with the engine used, so an absent field can be told from an empty one.

All timestamps are ISO 8601 in UTC. All hashes are SHA-256, lower-case hexadecimal. Sizes are in bytes.

## Top level

| field | content |
| --- | --- |
| `format` | `"singlefile-manifest"` |
| `version` | `1` |
| `producer` | `name` (`"single-file-cli"`), `version`, `engine` (`"chromium"` or `"firefox"`), `engineVersion` as the browser reports it |
| `subject` | `url` as given on the command line, `finalUrl` the document the page ended on, `title` |
| `time` | `captureStarted` and `captureEnded` bracket the saving itself; `loaded` is the page's navigation start (its performance time origin), which precedes them by the page load and the wait options |
| `environment` | `userAgent`, `viewport` (`width`, `height`, `devicePixelRatio`), `media` (`prefersColorScheme`, `prefersReducedMotion`) as the page saw them |
| `options` | every option with a boolean or numeric value as SingleFile received it, the CLI's run options included, plus `customStylesheet` and `filenameTemplate` when given; an option that is absent was not set, and the options that only carry per-run data are left out |
| `frames` | one entry per document saved, the top page first (see below) |
| `output` | `mimeType`, `size` and `sha256` of the saved page bytes exactly as written, byte order mark included when `--include-bom` was set, and `filename` as written when a sidecar was written (see "Where the manifest goes") |
| `transport` | `requests`, `tls`, `certificates` (see below) |
| `crossChecks` | one entry per page resource whose URL the network layer also saw (see below) |
| `coverage` | what the network layer could observe (see below) |

`subject.url` and `subject.finalUrl` differ after a redirect, including the upgrades a browser performs on its own: an `http://` URL under HSTS becomes `https://` without any server being asked, and Chromium upgrades plain hosts that answer on `https://` while Firefox does not, so the same `http://` URL can end on different documents per engine.

## Frames

Each entry of `frames` is a document: the top page, then every frame whose content was saved.

| field | content |
| --- | --- |
| `id` | `"0"` for the top page, then a dotted path of 0-based frame indexes: `"0.0"` is the first frame of the top page, `"0.2.1"` the second frame of its third frame |
| `parent` | the `id` of the parent frame, `null` for the top page |
| `url` | the document's base URL |
| `lastModified` | the document's `Last-Modified` date as the browser exposes it; when the server sent none the browser substitutes the current time, so confirm it against the `last-modified` header of the document's request before reading it as a server date |
| `navigation` | the document's Navigation Timing entry: `transferSize`, `encodedBodySize`, `decodedBodySize`, `nextHopProtocol`, `status`, `type`, `redirectCount` |
| `resources` | the resources this document fetched while being saved |

`navigation.redirectCount` is what the page's own API reports. It is 0 after an internal upgrade, which the browser hides from the page, and also after a cross-origin redirect, which Resource Timing hides unless the server allowed it. The document's request in `transport.requests` is the authority on redirects.

### Resources

A resource entry describes one fetch made by the page layer. Resources given as `data:` URLs are not listed, since nothing was fetched.

| field | content |
| --- | --- |
| `url` | the URL the document referenced, resolved |
| `finalUrl` | the URL the response came from, after redirects |
| `role` | what the resource was used as: `document`, `stylesheet`, `script`, `image` or `font`; `document` is also the default when no more specific kind applies |
| `fetchedBy` | `page` when the top page fetched it, `frame` when it belongs to a frame document and was fetched on the first attempt, `cli` when the fetch was made outside the browser (see `transport.requests`) |
| `outcome` | `embedded` when the resource went into the saved page, `failed` when the fetch failed, `blocked` when an option blocked it, `rejected` when the response was unusable, `oversized` when it exceeded `--max-resource-size` |
| `status` | the HTTP status |
| `headers` | the response headers among `date`, `last-modified`, `etag`, `content-length`, `content-encoding`, `cache-control`, `age`, `expires`, `server` |
| `size`, `sha256` | the bytes the page received, after content decoding |
| `contentType`, `charset` | the type SingleFile decided on: sniffed from the bytes when it recognises them, otherwise from the response header; the charset falls back to the document's. It can differ from the `mimeType` of the same URL in `transport.requests` |
| `references` | how many places in the document asked for this URL |
| `timing` | the page's Resource Timing entry for this URL, same fields as `navigation` without `type` and `redirectCount` |
| `error` | the failure message when `outcome` is `failed` |

A status of 400 or more makes a stylesheet, script or font `rejected`. An image or a document resource with such a status still reads `embedded`: SingleFile keeps whatever the server sent back for them, so that the saved page shows what the live one showed.

In the CLI, every fetch of the page layer runs from the top page's context, for frame documents too: `frame` says which document the resource belongs to, not that the frame's own origin or cookies were used. A frame resource reads `page` when the first attempt failed and the same fetch was retried.

## Transport

### Requests

One entry per request the browser made over `http:` or `https:` for the saved page and its frames, in the order they started, plus the requests the CLI made itself. Requests to other schemes are not listed.

| field | content |
| --- | --- |
| `id` | the engine's request id, or `cli-N` for a request the CLI made |
| `url` | the first URL the browser sent a request to |
| `finalUrl` | the URL of the response, after redirects |
| `method`, `started` | the HTTP method and the time the request was sent |
| `type` | Chromium's resource type (`document`, `stylesheet`, `image`, ...); absent on Firefox |
| `redirects` | the hops the browser reported: `url`, `status`, `location`, and `remote` when known |
| `redirectCount` | the number of redirects the browser followed; on Firefox, the browser's own count, on Chromium the length of `redirects` |
| `status`, `statusText`, `protocol`, `mimeType` | from the final response |
| `headers` | every response header, lower-cased, except `set-cookie` |
| `fromCache`, `fromServiceWorker` | whether the response came from the browser cache or a service worker; `fromServiceWorker` is Chromium only |
| `encodedSize` | bytes received over the network for this request |
| `remote` | `ip` and `port` of the server; Chromium only |
| `securityState` | Chromium's assessment of the connection (`secure`, `insecure`, ...) |
| `tls` | the hostname whose `transport.tls` entry covers this request; Chromium only |
| `body` | `size`, `sha256` and `encoding` of the response body, or `error` when it could not be read |
| `error`, `canceled` | the failure text when the request did not complete, and whether the browser canceled it |
| `fetchedBy` | `cli` on a request the CLI made itself; absent otherwise |
| `redirected` | on a CLI request, whether `fetch()` followed a redirect to reach the response |

`redirects` starts at the first request the browser actually sent. Firefox follows an HSTS upgrade without reporting the `http://` hop, so a request can have `redirectCount: 1` with an empty `redirects` list, and its `url` is the `https://` one while `subject.url` says `http://`. Chromium reports the same upgrade as a 307 hop with no `remote`.

`body` holds the body after content decoding, not the bytes on the wire: a gzip-compressed response is hashed decompressed, which is also what the page layer hashes. `encoding` says how the engine handed the body back: `decoded` means bytes, `text` means the engine returned a string, which Firefox does whenever the server declared a text type. A string round-trips most text unchanged, but a byte order mark is lost and a binary resource served as text is re-encoded, so a `text` hash that differs from the page's is not comparable rather than wrong. Bodies are not read for responses outside the 200 range, for 204, and on Chromium for media streams, WebSocket, EventSource, ping and CSP report requests. Above 32 MB, Chromium skips the body when the `Content-Length` header says so, and Firefox reports `body.error` instead of a hash.

A request with `fetchedBy: "cli"` was made by the CLI process, outside the browser, because the page could not fetch the resource itself: a cross-origin stylesheet without CORS headers is the usual case. The CLI sends the user agent, the extra headers and the referrer the browser would have sent, but it uses no browser cookies and no browser cache, and `fetch()` reports whether it followed a redirect without listing the hops. The resource entry it served is relabelled `fetchedBy: "cli"` in `frames`, matched by URL and hash.

### TLS

`tls` has one entry per hostname that answered a response or a redirect over `https://`, keyed by hostname. A host whose requests all failed or all came from the cache has none.

| field | content |
| --- | --- |
| `source` | `connection` when the browser reported the TLS session of its own connection (Chromium), `handshake` when the browser reported nothing and the CLI opened a separate TLS connection to the host to record it (Firefox, and a host Chromium reached only through a redirect) |
| `protocol`, `cipher` | the TLS version and cipher; Chromium names the cipher as `AES_128_GCM`, a handshake as `TLS_AES_128_GCM_SHA256` |
| `keyExchange`, `keyExchangeGroup` | Chromium only |
| `subjectName`, `issuer`, `validFrom`, `validTo` | from the certificate the browser saw; a handshake records `subjectName` and `validTo` |
| `sct`, `ctCompliance` | the signed certificate timestamps and the Certificate Transparency verdict; Chromium only |
| `certificate` | the SHA-256 fingerprint of the leaf certificate, a key of `certificates` |
| `certificateSource` | `connection` when the certificate chain came from the browser, `handshake` when it came from the CLI's own connection; a Chromium host whose session the browser reported without a chain keeps `source: connection` and gets `certificateSource: handshake` |
| `handshake` | the time of the CLI's own handshake, when one was made |
| `verified`, `verificationError` | whether the runtime's trust store accepted the chain presented to the handshake, and why not. Without `--browser-ignore-insecure-certs` a rejected chain ends the handshake instead, and the host carries `handshakeError` |
| `certificateConsistent` | on a Chromium host where the browser reported the session but not the chain: whether the handshake's leaf has the same subject and expiry as the one the browser saw; `handshakeSubjectName` and `handshakeValidTo` are given when it does not |
| `handshakeError` | why the handshake failed, when it did |

A handshake is a second connection made after the capture. The certificate it records is the one the server presented to the CLI at that moment, which is the same as the browser's in the normal case and is checked against the browser's own report whenever that report exists. It is not evidence of what the browser's connection used: `certificateSource: connection` is the stronger case.

### Certificates

`certificates` maps a SHA-256 fingerprint to `der`, the certificate in DER form encoded in base64, and on a leaf `chain`, the fingerprints of the issuing certificates. The chain is the one the browser or the CLI's runtime built while verifying, not necessarily what the server sent: the two engines can record different chains for the same host, one ending at a root and the other at a cross-signed intermediate. The fingerprint is the SHA-256 of the DER bytes, so each entry can be checked against its key.

## Cross-checks

One entry per resource in `frames` whose final URL the network layer also saw with a body. The final URL is the join key between `frames[].resources` and `transport.requests`; on Chromium a request's `tls` names its TLS entry, on Firefox the hostname of the final URL does.

| field | content |
| --- | --- |
| `url` | the final URL |
| `captureSha256` | the hash the page layer computed |
| `transportSha256` | the matching network hash, or the last one seen when none matches |
| `match` | whether a network body carries the page's hash |
| `transportVariants` | when the browser requested the URL several times and got several different bodies, how many |
| `comparable` | `false` when the only network hash was taken on text (see `body.encoding`) and differs, so the two cannot be compared |

A resource absent from `crossChecks` is one without a hash on one side: the page never received bytes for it (`blocked`, or `failed` before any body arrived), or the network layer never saw a body for it, because it was served from the browser cache, fetched before the capture started listening, or skipped by the body rules above.

## Coverage

| field | values |
| --- | --- |
| `tls` | `connection` when the browser reported its TLS sessions, `handshake` when only the CLI's own handshakes did, `none` |
| `remoteAddress` | `observed` when server addresses were recorded, `none` |
| `bodies` | `decoded` when at least one response body was hashed as bytes, `text` when bodies were hashed but only as strings (see `body.encoding`), `none` |
| `redirects` | `from-first-sent-request`: redirect chains start at the first request the browser sent, not at the URL given |

With Firefox, `tls` is `handshake` and `remoteAddress` is `none`: WebDriver BiDi exposes neither the TLS session nor the server address.

## Where the manifest goes

- By default, `<page filename>.manifest.json` next to the saved page, in canonical JSON, with `output.filename` set. In crawl mode each saved page gets its own.
- With `--output-json`, the manifest is a `manifest` property of the JSON written instead of the page, and no sidecar is written. That JSON is not canonical, `output.filename` is absent, and `output.sha256` is the hash of the page content carried inside the JSON, not of the JSON file.
- With `--dump-json`, the JSON printed on stdout carries `manifest` and `manifestFilename`, and the sidecar is written as usual.
- With `--dump-content` and no output file, the manifest is only available through `--dump-json`, without `output.filename`.
- `--manifest` is refused with `--crawl-save-archive`.

## Verifying a capture

1. Hash the saved file and compare with `output.sha256` and `output.size`. The file must be read as bytes.
2. For a sidecar, parse the manifest, canonicalize it and compare with the sidecar's bytes to be sure it was not altered or reformatted.
3. For each certificate, hash the DER bytes and compare with its key; check the chain with a trust store of your choice.
4. Read `coverage` before drawing conclusions from an absent field.
5. A resource with `outcome: "embedded"`, a matching `crossChecks` entry and a `transport.requests` entry with `remote` and a `tls` entry whose `certificateSource` is `connection` is accounted for from the server to the saved file. A `handshake` certificate only says what the server presented to the CLI afterwards. A resource with `fetchedBy: "cli"` was fetched outside the browser and carries no browser cookies.

What the manifest does not establish: the time of the server's clock beyond the `date` headers it recorded, the content of the page as rendered rather than as fetched, and anything about requests the page made before the capture started listening or after it stopped.

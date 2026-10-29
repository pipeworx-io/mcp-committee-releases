# @pipeworx/committee-releases

Documents congressional committees publish on their **own** websites — press releases, oversight letters, staff reports, released interview transcripts and investigation files. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `search_committee_documents(...)` — find documents by headline across seven committees, filtered by `committee`, `doc_type` and (where dates exist) `since`.
- `get_committee_document(...)` — a document page's headline, publication date, published text and attached PDFs with URLs and sizes.
- `list_committee_document_types(...)` — which committees are covered and what each publishes.

## Auth

None.

## Why this exists

`congressional-documents` covers GovInfo — the official printed record, which lags the event by months and never receives the ad-hoc material a committee posts to its own site. This covers that gap, within hours of publication.

## Committees covered

| Committee | Chamber | Shape | Dates |
|---|---|---|---|
| `house-oversight` | House | typed | yes |
| `hsgac` | Senate | typed | yes |
| `senate-commerce` | Senate | typed | yes |
| `senate-judiciary` | Senate | flat | **no** |
| `senate-foreign-relations` | Senate | flat | **no** |
| `senate-help` | Senate | flat | **no** |
| `senate-aging` | Senate | flat | **no** |

~40,600 documents indexed. All 30 major House and Senate committees were surveyed on 2026-07-30: **most House committees publish no sitemap at all**, so they cannot be added without a new adapter.

**`flat` committees publish a sitemap with no dates.** Their results carry `last_updated: null`, sort alphabetically rather than by recency, and **refuse `since`** instead of applying it to undated rows — which would return pre-cutoff documents as though they had passed the filter. The response says so via `dates_unavailable`.

Not every committee publishes every type. A `doc_type` a committee does not publish returns an explicit `unavailable_types` and a note, never an empty list that would read as "nothing on the subject".

## Coverage and limits

- **Search matches the document headline/slug, not body or PDF text.** Searching 40,000 pages of body text needs full-text indexing. A null result means no headline matched — not that the subject is absent.
- **PDF text is not extracted.** Attachments come back as url + filename + bytes. Quote the page text and cite the attachment as a link; do not represent a PDF as having been read.
- Some pages are pure file wrappers with no prose of their own; those return empty text plus a `no_prose_note` rather than the site footer.
- `get_committee_document` fetches a caller-supplied URL, so it is **host-allowlisted** to the seven committee domains.

## A deliberate omission

No person→mentions tool, for the reasons set out in `congressional-documents`: a name is not an identifier, and being named in a committee document is not an allegation.

## Data sources

Each committee's Yoast sitemap index or `sitemap.xml`, e.g.:

- `https://oversight.house.gov/sitemap_index.xml`
- `https://www.hsgac.senate.gov/sitemap_index.xml`
- `https://www.judiciary.senate.gov/sitemap.xml`

All are served under a `robots.txt` with an empty `Disallow:` — crawling explicitly permitted.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "committee-releases": {
      "url": "https://gateway.pipeworx.io/committee-releases/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/committee-releases/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/search_committee_documents \
  -H 'Content-Type: application/json' \
  -d '{"query":"subpoena","limit":5}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/search_committee_documents`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-committee-releases` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/committee-releases/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "committee-releases": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-committee-releases"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Committee Releases data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT

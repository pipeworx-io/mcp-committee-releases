# @pipeworx/committee-releases

Documents congressional committees publish on their **own** websites — press releases, oversight letters, staff reports, released interview transcripts and investigation files. Keyless.

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

- **Search matches the document headline/slug, not body or PDF text.** Searching 40,000 pages of body text needs a hosted index. A null result means no headline matched — not that the subject is absent.
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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Committee Releases data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [All tools and guides](https://github.com/pipeworx-io/examples)
- [pipeworx.io](https://pipeworx.io)

## License

MIT

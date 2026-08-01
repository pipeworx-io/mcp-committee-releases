interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Committee Releases — documents congressional committees publish on their OWN
 * websites: press releases, oversight letters, staff reports, released interview
 * transcripts, investigation files and hearing material.
 *
 * WHY THIS EXISTS, and how it differs from `congressional-documents`. That pack
 * covers GovInfo — the official printed record. Publication there lags the event
 * by months, and the ad-hoc material a committee posts to its own site never
 * appears at all. This covers that gap, within hours of publication.
 *
 * THE MECHANISM (and why it generalises). Both committees run WordPress with the
 * REST API LOCKED ("DRA: Only authenticated users can access the REST API" →
 * 401), but both serve robots.txt with an EMPTY `Disallow:` — crawling is
 * explicitly permitted — and both let Yoast publish a TYPED sitemap index: one
 * sitemap per content type, every entry stamped `lastmod`. That index is the
 * whole product. No listing-page scraping, no pagination guessing.
 *
 * WHAT DOES NOT GENERALISE, and it is most of the work:
 *
 *   - The content-type VOCABULARY is per-site. Oversight has `release`,
 *     `letter`, `report`. HSGAC has 61 types, split by PARTY
 *     (`rep_press_releases` / `dem_press_releases`) and by SUBCOMMITTEE
 *     (`files_invest`, `hearings_etso`, …). Each committee therefore needs its
 *     own map from a shared vocabulary onto its sitemap prefixes.
 *   - Page markup differs. Oversight wraps the body in <article>; HSGAC runs
 *     Elementor with no <article> or <main> at all, and a whole-page fallback
 *     there yields ~57,000 characters of inlined CSS. Hence the paragraph
 *     aggregation fallback.
 *   - Attachments live in different places. Oversight links PDFs from the release
 *     page itself; HSGAC press releases carry NONE, and its documents sit under a
 *     separate `files` post type at /library/files/<slug>/.
 *
 * Measured 2026-07-29 — House Oversight: 3,887 releases, ~2,300 letters, 159
 * reports, ~1,000 hearings. HSGAC: 2,729 majority + 3,077 minority releases,
 * 8,436 files, 1,480 investigation files, 1,584 hearings.
 *
 * HONESTY CONSTRAINTS, stated in every response rather than buried:
 *   - Search matches the URL SLUG, which mirrors the headline — NOT document body
 *     or PDF text. Searching 15,000+ pages of body text needs a hosted index. A
 *     null result means no headline matched, not that the subject is absent.
 *   - PDF text is NOT extracted. Attachments are returned as links with sizes.
 *   - No person→mentions tool, for the reasons set out in `congressional-documents`:
 *     a name is not an identifier, and being named is not an allegation.
 */


const UA = 'pipeworx-mcp-committee-releases/1.0 (+https://pipeworx.io)';

/**
 * Congressional committee sites come in two sitemap shapes, and only one of them
 * carries dates. Surveyed 30 committees on 2026-07-30:
 *
 *   'typed' — a Yoast index of per-content-type child sitemaps, every entry
 *     stamped `lastmod`. Full quality: filter by type, sort by recency, honour
 *     `since`. Only 3 of 30 committees do this.
 *
 *   'flat' — a single sitemap.xml listing every URL with NO <lastmod> at all.
 *     Search still works (slug matching), and the first path segment is a usable
 *     type discriminator, but there are NO DATES: results cannot be ordered by
 *     recency and `since` cannot be honoured. That limitation is reported rather
 *     than papered over.
 *
 * Most House committees publish no sitemap at all and are simply absent.
 */
type SitemapShape = 'typed' | 'flat';

interface Committee {
  slug: string;
  host: string;
  label: string;
  chamber: 'House' | 'Senate';
  shape: SitemapShape;
  /**
   * Shared vocabulary → this site's discriminators. For 'typed' sites these are
   * Yoast sitemap filename prefixes; for 'flat' sites they are first path
   * segments. Empty = not published here.
   */
  types: Record<string, string[]>;
  /** Sensible default when the caller names no doc_type. */
  defaultTypes: string[];
  /**
   * Minimum path-segment count for a real document on THIS site. Flat sitemaps
   * list section landing pages next to documents, and the depth at which
   * documents actually live differs per committee — measured 2026-07-30, Aging's
   * sit at depth 2 while Foreign Relations' sit at depth 4, so no global rule
   * works. Defaults to 2.
   */
  minDepth?: number;
  /** Extra note worth returning with this committee's results. */
  note?: string;
}

const COMMITTEES: Record<string, Committee> = {
  'house-oversight': {
    slug: 'house-oversight',
    host: 'oversight.house.gov',
    label: 'House Committee on Oversight and Government Reform',
    chamber: 'House',
    shape: 'typed',
    types: {
      releases: ['release'],
      letters: ['letter'],
      reports: ['report'],
      hearings: ['hearing'],
      markups: ['markup'],
      documents: [],
      investigations: [],
    },
    defaultTypes: ['releases', 'letters', 'reports', 'hearings'],
  },
  hsgac: {
    slug: 'hsgac',
    host: 'www.hsgac.senate.gov',
    label: 'Senate Homeland Security and Governmental Affairs Committee (HSGAC)',
    chamber: 'Senate',
    shape: 'typed',
    types: {
      // Party-split on this site: majority and minority publish separately, and a
      // caller asking what the committee said wants both.
      releases: ['rep_press_releases', 'dem_press_releases'],
      letters: [],
      reports: [],
      hearings: ['hearings'],
      documents: ['files'],
      investigations: ['files_invest', 'hearings_invest'],
    },
    defaultTypes: ['releases', 'hearings'],
    note:
      'HSGAC publishes majority and minority releases separately (both are searched). Its documents live ' +
      'under a distinct "documents" type at /library/files/ — press-release pages here carry no ' +
      'attachments, so use doc_type:"documents" or "investigations" to find PDFs.',
  },
  'senate-commerce': {
    slug: 'senate-commerce',
    host: 'www.commerce.senate.gov',
    label: 'Senate Committee on Commerce, Science, and Transportation',
    chamber: 'Senate',
    shape: 'typed',
    // Same platform family as HSGAC: party-split releases, and hearing material
    // under `meeting` with its attachments under `meeting_file`.
    types: {
      releases: ['rep_press_releases', 'dem_press_releases'],
      letters: [],
      reports: [],
      hearings: ['meeting'],
      markups: [],
      documents: ['meeting_file'],
      investigations: [],
    },
    defaultTypes: ['releases', 'hearings'],
    note: 'Majority and minority releases are published separately; both are searched.',
  },
  'senate-judiciary': {
    slug: 'senate-judiciary',
    host: 'www.judiciary.senate.gov',
    label: 'Senate Committee on the Judiciary',
    chamber: 'Senate',
    shape: 'flat',
    types: {
      releases: ['press'],
      letters: [],
      reports: [],
      hearings: ['committee-activity', 'hearings'],
      markups: [],
      documents: ['nominations', 'legislation'],
      investigations: [],
    },
    minDepth: 3,
    defaultTypes: ['releases', 'hearings'],
  },
  'senate-foreign-relations': {
    slug: 'senate-foreign-relations',
    host: 'www.foreign.senate.gov',
    label: 'Senate Committee on Foreign Relations',
    chamber: 'Senate',
    shape: 'flat',
    types: {
      releases: ['press'],
      letters: [],
      reports: [],
      hearings: ['hearings'],
      markups: [],
      documents: ['legislation'],
      investigations: [],
    },
    minDepth: 3,
    defaultTypes: ['releases', 'hearings'],
  },
  'senate-help': {
    slug: 'senate-help',
    host: 'www.help.senate.gov',
    label: 'Senate Committee on Health, Education, Labor and Pensions (HELP)',
    chamber: 'Senate',
    shape: 'flat',
    types: {
      releases: ['dem', 'rep', 'newsroom'],
      letters: [],
      reports: [],
      hearings: ['hearings'],
      markups: [],
      documents: ['committee-actions'],
      investigations: [],
    },
    minDepth: 3,
    defaultTypes: ['releases', 'hearings'],
    note: 'Majority and minority releases live under separate paths; both are searched.',
  },
  'senate-aging': {
    slug: 'senate-aging',
    host: 'www.aging.senate.gov',
    label: 'Senate Special Committee on Aging',
    chamber: 'Senate',
    shape: 'flat',
    types: {
      releases: ['press-releases'],
      letters: [],
      reports: [],
      hearings: ['hearings'],
      markups: [],
      documents: ['download'],
      investigations: [],
    },
    defaultTypes: ['releases', 'hearings'],
  },
};

const VOCAB = ['releases', 'letters', 'reports', 'hearings', 'markups', 'documents', 'investigations'];

const SEARCH_CAVEAT =
  'Search matches the document URL slug, which mirrors its headline — not the text inside the document ' +
  'or its PDF attachments. A null result means no headline matched; it does not mean the subject is ' +
  'absent from the committee\'s documents.';

const DISCLOSURE =
  'These are documents a committee chose to publish. A person named in one is not thereby accused of ' +
  'anything — committee documents name correspondents, witnesses, officials and people mentioned in ' +
  'passing. Quote and cite the document; do not infer wrongdoing from a mention.';

const SCOPE_NOTE =
  'Covers committee-website material only, and only the committees listed by ' +
  'list_committee_document_types. For the official printed record (full hearing transcripts, committee ' +
  'reports as published by GPO, the Congressional Record) use search_congressional_documents.';

/** Chrome linked from every page, belonging to no single document. */
const BOILERPLATE = /Committee-Rules|committee-rules/i;

/**
 * Footer/contact blocks that sit in <p> tags on every page. Without this, a page
 * with no prose of its own returns the committee's street address as though it
 * were the document text.
 */
const SITE_CHROME =
  /Senate Office Building|House Office Building|All Rights Reserved|Privacy Policy|For media inquiries|\(\d{3}\)\s?\d{3}-\d{4}/i;

// ── HTTP ────────────────────────────────────────────────────────────

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, redirect: 'follow' });
  if (res.status === 404) throw new Error(`Not found at ${url} (HTTP 404).`);
  if (res.status === 429) {
    throw new Error(`upstream_throttled: ${new URL(url).hostname} rate-limited the request (HTTP 429).`);
  }
  if (!res.ok) throw new Error(`${new URL(url).hostname} returned HTTP ${res.status} for ${url}`);
  return res.text();
}

// ── Parsing ─────────────────────────────────────────────────────────

function parseSitemap(xml: string): { url: string; lastmod: string | null }[] {
  const out: { url: string; lastmod: string | null }[] = [];
  // Pair <loc> with <lastmod> INSIDE each <url> block. Zipping two positional
  // arrays breaks the moment one entry omits lastmod, shifting every later date.
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const block = m[1];
    const loc = block.match(/<loc>([^<]+)<\/loc>/)?.[1];
    if (!loc) continue;
    out.push({ url: loc.trim(), lastmod: block.match(/<lastmod>([^<]+)<\/lastmod>/)?.[1]?.trim() ?? null });
  }
  return out;
}

/**
 * Sitemaps list section landing pages (/release/) and the homepage beside real
 * documents. Newest-first those take slot 1 with a headline of literally
 * "release". A real document has at least two path segments.
 */
function isDocumentUrl(url: string): boolean {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).length >= 2;
  } catch {
    return false;
  }
}

function slugTitle(url: string): string {
  const seg = url.replace(/\/+$/, '').split('/').pop() ?? '';
  return decodeURIComponent(seg)
    .replace(/[-_]+/g, ' ')
    // Some Senate slugs begin with a stray separator, which surfaced as
    // headlines like "_keystone xl and the national interest determination".
    .replace(/^[\s_-]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;|&#8212;/g, '—')
    .replace(/&ndash;|&#8211;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&ldquo;|&rdquo;|&quot;|&#8220;|&#8221;/g, '"')
    .replace(/&lsquo;|&rsquo;|&#8216;|&#8217;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&'); // last, so "&amp;mdash;" does not double-decode
}

function toText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    // WordPress nests enough empty blocks that runs arrive as "\n \n \n" —
    // newlines separated by spaces, which /\n{3,}/ does not match. Drop
    // whitespace-only lines instead, then cap the gaps.
    .split('\n')
    .map((l) => l.trim())
    .filter((l, i, a) => l.length > 0 || (i > 0 && a[i - 1].trim().length > 0))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Body text, by whichever route the site allows.
 *
 * <article> is preferred where it exists (Oversight) because it preserves the
 * "Published: <date>" line. HSGAC runs Elementor with no <article> or <main>, and
 * a whole-page fallback there returns ~57,000 characters of inlined CSS — so the
 * fallback aggregates <p> elements, which holds the prose and excludes chrome.
 */
function extractBody(html: string): { text: string; scope: string; strategy: string } {
  const article = html.match(/<article[\s\S]*?<\/article>/i);
  if (article) {
    const t = toText(article[0]);
    if (t.length > 80) return { text: t, scope: article[0], strategy: 'article' };
  }
  const paras = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => toText(m[1]))
    .filter((t) => t.length > 30 && !SITE_CHROME.test(t));
  if (paras.length) return { text: paras.join('\n\n'), scope: html, strategy: 'paragraphs' };
  // A page can legitimately have no prose: HSGAC's `files` entries are wrappers
  // whose whole substance is the attached PDF. Before this filter they returned
  // the footer — "340 Dirksen Senate Office Building … (202) 224-4751" — which a
  // summarizer could quote as though it were the document's content. Better to
  // return nothing and say the substance is attached.
  return { text: '', scope: html, strategy: 'no-prose-on-page' };
}

// ── Committee / type resolution ─────────────────────────────────────

function resolveCommittees(input: unknown): Committee[] {
  const raw = typeof input === 'string' ? input.toLowerCase().trim() : '';
  if (!raw || raw === 'all') return Object.values(COMMITTEES);
  const direct = COMMITTEES[raw];
  if (direct) return [direct];
  // Forgiving aliases for how people actually name these.
  const alias = Object.values(COMMITTEES).find(
    (c) =>
      c.host.includes(raw) ||
      c.label.toLowerCase().includes(raw) ||
      (raw.includes('oversight') && c.slug === 'house-oversight') ||
      (/hsgac|homeland|governmental affairs/.test(raw) && c.slug === 'hsgac'),
  );
  if (alias) return [alias];
  throw new Error(
    `Unknown committee "${raw}". Valid values: ${Object.keys(COMMITTEES).join(', ')}, or "all". ` +
    `Call list_committee_document_types to see what each publishes.`,
  );
}

function resolveTypes(
  input: unknown,
  committee: Committee,
): { requested: string[]; prefixes: string[]; unavailable: string[] } {
  const raw = typeof input === 'string' ? input.toLowerCase().trim() : '';
  let requested: string[];
  if (!raw || raw === 'all') {
    requested = raw === 'all' ? VOCAB : committee.defaultTypes;
  } else {
    const norm = VOCAB.includes(raw) ? raw : VOCAB.includes(`${raw}s`) ? `${raw}s` : null;
    if (!norm) {
      throw new Error(
        `Unknown doc_type "${raw}". Valid values: ${VOCAB.join(', ')}, or "all". ` +
        `(releases = press releases, letters = letters the committee sent, documents = attached files, ` +
        `investigations = investigation material.)`,
      );
    }
    requested = [norm];
  }
  const prefixes: string[] = [];
  const unavailable: string[] = [];
  for (const t of requested) {
    const p = committee.types[t] ?? [];
    if (p.length) prefixes.push(...p);
    else unavailable.push(t);
  }
  return { requested, prefixes, unavailable };
}

/**
 * Entries for a 'flat' committee: one sitemap.xml holding every URL, with no
 * per-type child sitemaps and no <lastmod>. The first path segment is the type
 * discriminator (e.g. /press/, /hearings/, /nominations/).
 */
async function flatEntries(committee: Committee, segments: string[]): Promise<{ url: string; lastmod: string | null }[]> {
  const xml = await fetchText(`https://${committee.host}/sitemap.xml`);
  const wanted = new Set(segments.map((s) => s.toLowerCase()));
  const minDepth = committee.minDepth ?? 2;
  return parseSitemap(xml).filter((e) => {
    try {
      const segs = new URL(e.url).pathname.split('/').filter(Boolean);
      if (segs.length < minDepth) return false;
      return wanted.has(segs[0].toLowerCase());
    } catch {
      return false;
    }
  });
}

/** Which child sitemaps in this committee's index match these prefixes. */
async function sitemapsFor(committee: Committee, prefixes: string[]): Promise<string[]> {
  const idx = await fetchText(`https://${committee.host}/sitemap_index.xml`);
  const children = [...idx.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  // Yoast paginates as `<prefix>-sitemap.xml`, `<prefix>-sitemap2.xml`, … Match by
  // prefix so a new page needs no code change. Anchored so `files` cannot swallow
  // `files_invest`.
  return children.filter((c) => {
    const file = c.split('/').pop() ?? '';
    return prefixes.some((p) => new RegExp(`^${p}-sitemap\\d*\\.xml$`).test(file));
  });
}

// ── Tools ───────────────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'search_committee_documents',
    description:
      'Find documents published by a congressional committee on its own website — press releases, ' +
      'oversight letters, staff reports, released interview transcripts, investigation files and hearing ' +
      'material. Covers the House Oversight Committee and the Senate Homeland Security and Governmental ' +
      'Affairs Committee (HSGAC). Use for "what has House Oversight said about X", "the Oversight ' +
      'Committee letter to Y", "HSGAC investigation into Z", "transcripts the committee released". This ' +
      'material appears within hours, unlike the official printed record which lags by months (use ' +
      'search_congressional_documents for that). IMPORTANT: matches the document headline/slug, not the ' +
      'text inside documents or their PDF attachments — an empty result means no headline matched rather ' +
      'than that the subject is absent.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'Keywords matched against document headlines, all of which must appear, e.g. "subpoena FBI". ' +
            'Omit to list the most recent documents.',
        },
        committee: {
          type: 'string',
          description:
            'Which committee: "house-oversight", "hsgac", or "all" (default). Also accepts loose names ' +
            'like "oversight" or "homeland security".',
        },
        doc_type: {
          type: 'string',
          description:
            'What to search: "releases", "letters", "reports", "hearings", "markups", "documents" ' +
            '(attached files), "investigations", or "all". Omit for each committee\'s sensible default. ' +
            'Not every committee publishes every type — the response names any that were unavailable.',
        },
        since: { type: 'string', description: 'Only documents updated on or after this date, YYYY-MM-DD' },
        limit: { type: 'number', description: 'Results to return (default 20, max 100)' },
      },
    },
  },
  {
    name: 'get_committee_document',
    description:
      'Read a committee document page: its headline, publication date, the text the committee published, ' +
      'and the attached documents (usually PDFs — letters, transcripts, reports) with URLs and sizes. ' +
      'Pass a url from search_committee_documents. Note that PDF text is NOT extracted — attachments are ' +
      'returned as links, so quote the page text and cite the attachment URL rather than claiming to have ' +
      'read the PDF.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'Full committee document URL, as returned by search_committee_documents',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'list_committee_document_types',
    description:
      'List the congressional committees covered here, which document types each one publishes on its ' +
      'website, and what this source does and does not cover. Call when unsure which committee or ' +
      'doc_type answers a question.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'list_committee_document_types':
      return {
        committees: Object.values(COMMITTEES).map((c) => ({
          committee: c.slug,
          name: c.label,
          chamber: c.chamber,
          website: `https://${c.host}`,
          publishes: VOCAB.filter((t) => (c.types[t] ?? []).length),
          not_published_here: VOCAB.filter((t) => !(c.types[t] ?? []).length),
          default_doc_types: c.defaultTypes,
          ...(c.note ? { note: c.note } : {}),
        })),
        doc_type_vocabulary: VOCAB,
        scope: SCOPE_NOTE,
        search_caveat: SEARCH_CAVEAT,
        disclosure: DISCLOSURE,
      };

    case 'search_committee_documents': {
      const committees = resolveCommittees(args.committee);
      const limit = Math.min(Math.max(Number(args.limit ?? 20), 1), 100);
      const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
      const terms = query ? query.split(/\s+/).filter((t) => t.length > 1) : [];
      const since = typeof args.since === 'string' && args.since.trim() ? args.since.trim() : null;

      const results: Record<string, unknown>[] = [];
      const perCommittee: Record<string, unknown>[] = [];

      for (const c of committees) {
        const { requested, prefixes, unavailable } = resolveTypes(args.doc_type, c);
        if (!prefixes.length) {
          // Say so rather than returning an empty list that reads as "nothing found".
          perCommittee.push({
            committee: c.slug,
            searched_types: [],
            unavailable_types: unavailable,
            indexed: 0,
            note: `${c.label} does not publish ${unavailable.join(', ')} on its website.`,
          });
          continue;
        }
        const entries: { url: string; lastmod: string | null }[] = [];
        if (c.shape === 'flat') {
          entries.push(...(await flatEntries(c, prefixes)));
        } else {
          const maps = await sitemapsFor(c, prefixes);
          // Fetch child sitemaps CONCURRENTLY. Sequentially this took 16s for
          // HSGAC releases (7 sitemaps, 5,806 entries) — long enough to risk a
          // client timeout on a cold cache. The work is pure I/O, so there is no
          // reason to serialise it.
          const pages = await Promise.all(maps.map((m) => fetchText(m)));
          for (const xml of pages) {
            entries.push(...parseSitemap(xml).filter((e) => isDocumentUrl(e.url)));
          }
        }

        // A flat site publishes no dates at all, so `since` cannot be applied.
        // Silently ignoring it would return pre-cutoff documents as though they
        // passed the filter, which is worse than refusing.
        const datesAvailable = c.shape === 'typed';
        const hits = entries.filter((e) => {
          if (since && datesAvailable && (!e.lastmod || e.lastmod.slice(0, 10) < since)) return false;
          if (!terms.length) return true;
          // Match the SLUG ONLY, never the full URL. Including the URL meant the
          // host matched every document on it: query "oversight" returned all
          // 7,482 documents on oversight.house.gov, because the hostname
          // contains the term. This also keeps behaviour consistent with what
          // the tool description promises.
          const hay = slugTitle(e.url).toLowerCase();
          return terms.every((t) => hay.includes(t));
        });
        // Newest-first where dates exist; alphabetical otherwise, so ordering is
        // at least deterministic rather than sitemap-insertion order pretending
        // to be recency.
        if (datesAvailable) hits.sort((a, b) => (b.lastmod ?? '').localeCompare(a.lastmod ?? ''));
        else hits.sort((a, b) => a.url.localeCompare(b.url));

        perCommittee.push({
          committee: c.slug,
          searched_types: requested.filter((t) => (c.types[t] ?? []).length),
          ...(unavailable.length ? { unavailable_types: unavailable } : {}),
          indexed: entries.length,
          matches: hits.length,
          ...(datesAvailable
            ? {}
            : {
                dates_unavailable: true,
                dates_note:
                  `${c.label} publishes a sitemap with no dates, so results from it carry last_updated: null, ` +
                  `are ordered alphabetically rather than by recency, and CANNOT be filtered by "since". ` +
                  `Open a result with get_committee_document to read its published date from the page.`,
                ...(since ? { since_ignored_for_this_committee: since } : {}),
              }),
        });

        for (const h of hits.slice(0, limit)) {
          results.push({ url: h.url, committee: c.slug, headline: slugTitle(h.url), last_updated: h.lastmod });
        }
      }

      results.sort((a, b) => String(b.last_updated ?? '').localeCompare(String(a.last_updated ?? '')));
      const trimmed = results.slice(0, limit);

      return {
        query: query || null,
        committees_searched: committees.map((c) => c.slug),
        per_committee: perCommittee,
        returned: trimmed.length,
        results: trimmed,
        next_step: trimmed.length
          ? 'Pass a url to get_committee_document for the page text, publication date and attached PDFs.'
          : 'No headline matched. Try fewer or broader keywords, another doc_type, or committee:"all" — and note the search caveat.',
        search_caveat: SEARCH_CAVEAT,
        scope: SCOPE_NOTE,
        disclosure: DISCLOSURE,
      };
    }

    case 'get_committee_document': {
      const raw = (args.url as string | undefined)?.trim();
      if (!raw) {
        throw new Error(
          'Required argument "url" is missing. Pass a full committee document URL from search_committee_documents.',
        );
      }
      let parsed: URL;
      try {
        parsed = new URL(raw);
      } catch {
        throw new Error(`"${raw}" is not a valid URL. Pass a full https URL from search_committee_documents.`);
      }
      // Host allowlist. This tool fetches a caller-supplied URL, so it must never
      // be usable as a general-purpose fetcher against arbitrary hosts.
      const committee = Object.values(COMMITTEES).find((c) => c.host === parsed.hostname.toLowerCase());
      if (parsed.protocol !== 'https:' || !committee) {
        throw new Error(
          `This tool only reads documents on: ${Object.values(COMMITTEES).map((c) => `https://${c.host}`).join(', ')}. ` +
          `Got "${parsed.protocol}//${parsed.hostname}". Use search_committee_documents to get a valid url.`,
        );
      }

      const html = await fetchText(parsed.toString());
      const { text, scope, strategy } = extractBody(html);

      const pageTitle = decodeEntities(html.match(/<title>([^<]*)<\/title>/i)?.[1] ?? '')
        .replace(/\s*[-|]\s*(United States|Committee on).*$/i, '')
        .trim();
      // Date, by whatever the site actually exposes. Oversight emits JSON-LD
      // `datePublished`; HSGAC emits NO date metadata at all — no
      // article:published_time, no datePublished, no <time datetime> — so it
      // legitimately comes back null there and the response says where to look
      // instead rather than leaving a bare null to be guessed at.
      const published =
        html.match(/"datePublished"\s*:\s*"([^"]+)"/)?.[1] ??
        text.match(/Published:\s*([A-Z][a-z]{2,8}\s+\d{1,2},\s*\d{4})/)?.[1] ??
        html.match(/datetime="(\d{4}-\d{2}-\d{2})/)?.[1] ??
        null;

      const abs = (href: string) => (href.startsWith('http') ? href : new URL(href, parsed).toString());
      // Prefer PDFs inside the body scope — that is what separates a document's own
      // attachments from site chrome. Oversight links its committee-rules PDF in the
      // footer of all ~3,900 releases, so a whole-page scrape attaches it to every
      // record. Where the body scope IS the whole page (paragraph strategy), the
      // boilerplate filter carries that weight instead.
      const inScope = [...new Set([...scope.matchAll(/href="([^"]*\.pdf[^"]*)"/gi)].map((m) => abs(m[1])))];
      const anywhere = [...new Set([...html.matchAll(/href="([^"]*\.pdf[^"]*)"/gi)].map((m) => abs(m[1])))];
      const documents = inScope.filter((u) => !BOILERPLATE.test(u));
      const excluded = anywhere.filter((u) => !documents.includes(u));

      const withMeta = await Promise.all(
        documents.slice(0, 10).map(async (u) => {
          try {
            const r = await fetch(u, { method: 'HEAD', headers: { 'User-Agent': UA }, redirect: 'follow' });
            return {
              url: u,
              filename: decodeURIComponent(u.split('/').pop() ?? ''),
              bytes: r.headers.get('content-length') ? Number(r.headers.get('content-length')) : null,
              content_type: r.headers.get('content-type'),
            };
          } catch {
            // Metadata is a nice-to-have; never lose the caller's text over it.
            return { url: u, filename: decodeURIComponent(u.split('/').pop() ?? ''), bytes: null, content_type: null };
          }
        }),
      );

      return {
        url: parsed.toString(),
        committee: committee.slug,
        committee_name: committee.label,
        title: pageTitle || slugTitle(parsed.toString()),
        published,
        ...(published
          ? {}
          : {
              published_note:
                'This site publishes no machine-readable date on the page. Use the `last_updated` value ' +
                'that search_committee_documents returned for this url (it comes from the sitemap) as the ' +
                'best available timestamp.',
            }),
        text,
        text_chars: text.length,
        extraction: strategy,
        ...(text.length === 0
          ? {
              no_prose_note:
                'This page carries no prose of its own — it is a wrapper whose substance is the attached ' +
                'document below. Cite the attachment; there is no page text to quote.',
            }
          : {}),
        attached_documents: withMeta,
        attached_document_count: documents.length,
        ...(excluded.length
          ? {
              excluded_site_chrome: excluded.length,
              excluded_note:
                'PDFs linked outside the document body (site navigation and footer, e.g. standing committee ' +
                'rules) were excluded — they appear on every page and belong to none of them.',
            }
          : {}),
        ...(documents.length === 0 && committee.slug === 'hsgac'
          ? {
              no_attachment_hint:
                'HSGAC press-release pages carry no attachments — its documents live under a separate type. ' +
                'Search doc_type:"documents" or "investigations" to find PDFs.',
            }
          : {}),
        pdf_text_note:
          'Attachment text is NOT extracted. Quote the page text above and cite attachment URLs as links; ' +
          'do not represent PDF contents as having been read.',
        scope: SCOPE_NOTE,
        disclosure: DISCLOSURE,
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default {
  tools,
  callTool,
  meter: { credits: 1 },
  provider: 'congressional committee websites',
} satisfies McpToolExport;

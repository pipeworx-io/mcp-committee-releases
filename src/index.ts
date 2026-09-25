interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities$shared(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities$shared(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
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
 *     or PDF text. Searching 15,000+ pages of body text needs full-text indexing. A
 *     null result means no headline matched, not that the subject is absent.
 *   - PDF text is NOT extracted. Attachments are returned as links with sizes.
 *   - No person→mentions tool, for the reasons set out in `congressional-documents`:
 *     a name is not an identifier, and being named is not an allegation.
 */


// Bound every fetch() in this pack to a fixed timeout — an upstream that
// degrades without erroring would otherwise hold the Worker in `await fetch()`
// until its own execution budget kills the request (minutes, not seconds).
// Mirrors the epoFetch / usaspending retryFetch pattern (fleet #685).
async function pwFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Committee Releases');
}

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
  const res = await pwFetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, redirect: 'follow' });
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
            const r = await pwFetch(u, { method: 'HEAD', headers: { 'User-Agent': UA }, redirect: 'follow' });
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

// Resolves a gemeente name to a DIRECT link into its currently-in-force APV —
// not a generic search page. Reuses the CVDR SRU search service that
// app/api/cron/apv-watch/route.js already queries for the "which APVs changed
// recently" scan, but here we look up one specific gemeente on demand and, if
// we can find the wildplassen/natuurlijke-behoefte article, deep-link straight
// to that article's anchor on the CVDR HTML page.

const CVDR_SRU_URL = "https://zoekservice.overheid.nl/sru/Search";

// Same distinction as apv-watch: dcterms:type carries both a generic
// "regeling" value and a more specific overheidop:Rubriek value — only the
// latter tells us this record IS the consolidated bylaw itself (not a related
// aanwijzingsbesluit/uitvoeringsbesluit that also matches the title search).
const APV_TYPE = "algemeen verbindend voorschrift (verordening)";

const WILDPLAS_RE = /wildplas\w*|natuurlijke behoefte|urineren/i;
const ARTICLE_RE = /Artikel\s*\d+[:.]\d+[a-z]?/gi;
const ARTICLE_LOOKBACK = 2000;
const ANCHOR_LOOKBACK = 4000;

const FETCH_TIMEOUT_MS = 6000;

async function fetchWithTimeout(url, opts) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function extractText(xml) {
  return xml
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nearestArticle(text, matchIndex) {
  const windowStart = Math.max(0, matchIndex - ARTICLE_LOOKBACK);
  const before = text.slice(windowStart, matchIndex);
  const found = [...before.matchAll(ARTICLE_RE)];
  return found.length > 0 ? found[found.length - 1][0] : null;
}

// Finds the gemeente's current, in-force APV record. A gemeente typically has
// many historical CVDR records (old versions, amendments); "in force" means
// it has an inwerkingtredingDatum but no uitwerkingtredingDatum (hasn't been
// superseded yet). Picks the most recently-taken-effect one among those, in
// case more than one still qualifies.
async function findCurrentApvRecord(gemeente) {
  const query = `dcterms.title="algemene plaatselijke verordening" AND dcterms.creator="${gemeente}"`;
  const url = `${CVDR_SRU_URL}?version=1.2&operation=searchRetrieve&x-connection=CVDR&maximumRecords=100&query=${encodeURIComponent(query)}`;

  const res = await fetchWithTimeout(url);
  if (!res.ok) return null;
  const xml = await res.text();
  if (xml.includes("<diagnostics")) return null;

  const records = xml.split("<record>").slice(1);
  let best = null;
  for (const chunk of records) {
    const rubriek = /<dcterms:type scheme="overheidop:Rubriek">([^<]*)<\/dcterms:type>/.exec(chunk)?.[1];
    if (rubriek !== APV_TYPE) continue;

    const uitwerking = /<overheidrg:uitwerkingtredingDatum>([^<]*)<\/overheidrg:uitwerkingtredingDatum>/.exec(chunk)?.[1];
    if (uitwerking) continue; // superseded by a later version

    const inwerking = /<overheidrg:inwerkingtredingDatum>([^<]*)<\/overheidrg:inwerkingtredingDatum>/.exec(chunk)?.[1];
    const preferredUrl = /<preferred_url>([^<]*)<\/preferred_url>/.exec(chunk)?.[1];
    const xmlUrl = /<publicatieurl_xml>([^<]*)<\/publicatieurl_xml>/.exec(chunk)?.[1];
    if (!preferredUrl || !xmlUrl) continue;

    if (!best || (inwerking || "") > (best.inwerking || "")) {
      best = { preferredUrl, xmlUrl, inwerking: inwerking || "" };
    }
  }
  return best;
}

// CVDR's HTML pages wrap each article in <section class="section-chapter"
// id="hoofdstuk_nX_paragraaf_nY_artikel_nZ"><div class="artikel">...
// <h4 class="docArtikel">Artikel 5.11 ...</h4> — the id sits on an ancestor
// tag some way before the heading text, not on the heading itself.
async function findArticleAnchor(htmlUrl, article) {
  const num = article.replace(/^Artikel\s*/i, "");
  const numPattern = num.replace(/[:.]/, "[:.]");
  const headingRe = new RegExp(`<h4[^>]*class="docArtikel"[^>]*>\\s*Artikel\\s*${numPattern}\\b`, "i");

  const res = await fetchWithTimeout(htmlUrl);
  if (!res.ok) return null;
  const html = await res.text();

  const m = headingRe.exec(html);
  if (!m) return null;

  const before = html.slice(Math.max(0, m.index - ANCHOR_LOOKBACK), m.index);
  const ids = [...before.matchAll(/id="([^"]+)"/g)];
  return ids.length > 0 ? ids[ids.length - 1][1] : null;
}

// In-memory, best-effort cache: gemeente APV text rarely changes, and Vercel
// Fluid Compute reuses warm instances, so this saves repeat SRU/XML/HTML
// round-trips for the same gemeente within a warm instance's lifetime. Not
// durable across cold starts — that's fine, it's just an optimization.
const cache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Returns { url, article } — url is a direct link to the gemeente's current
// APV, deep-linked to the specific article if we could locate one, or null
// if no APV record (or no article) could be found for this gemeente.
export async function findWildplasApvLink(gemeente) {
  if (!gemeente) return null;
  const key = gemeente.toLowerCase();

  const cached = cache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.value;

  let value = null;
  try {
    const record = await findCurrentApvRecord(gemeente);
    if (record) {
      value = { url: record.preferredUrl, article: null };

      const xmlRes = await fetchWithTimeout(record.xmlUrl);
      if (xmlRes.ok) {
        const text = extractText(await xmlRes.text());
        const match = WILDPLAS_RE.exec(text);
        if (match) {
          const article = nearestArticle(text, match.index);
          if (article) {
            value.article = article;
            const anchor = await findArticleAnchor(record.preferredUrl, article).catch(() => null);
            if (anchor) value.url = `${record.preferredUrl}#${anchor}`;
          }
        }
      }
    }
  } catch {
    value = null;
  }

  cache.set(key, { value, ts: Date.now() });
  return value;
}

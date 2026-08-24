import { NextResponse } from "next/server";
import { sendFindingsAlert } from "../../../../lib/notify.js";

// Daily watcher: scans recently-changed gemeente APVs for wildplassen-related
// clauses so a human can decide whether lib/exceptions.json needs an update.
// It does NOT edit exceptions.json itself — legal text needs a human read
// (e.g. distinguishing "verboden binnen de bebouwde kom" (already the default,
// nothing to do) from "verboden in het Xbos" (a real exception to add)).

// KOOP's CVDR SRU search service (distinct host from the general repository.overheid.nl
// "cup" catalog search used by /api/check — that one doesn't index CVDR full text).
const CVDR_SRU_URL = "https://zoekservice.overheid.nl/sru/Search";

// Every CVDR record carries a generic dcterms:type (scheme "overheid:Informatietype",
// always "regeling" for this search) AND a more specific one (scheme "overheidop:Rubriek").
// Only the latter distinguishes the consolidated bylaw itself from related instruments
// (aanwijzingsbesluiten, uitvoeringsbesluiten, ...) that also match the title search
// below but would just be noise for this check.
const APV_TYPE = "algemeen verbindend voorschrift (verordening)";

// How far back to look. Generous relative to the daily schedule so a slow SRU
// index update or a missed run doesn't silently drop a gemeente.
const LOOKBACK_DAYS = 3;

const WILDPLAS_PATTERNS = [
  { label: "wildplassen", re: /wildplas\w*/i },
  { label: "natuurlijke behoefte", re: /natuurlijke behoefte/i },
  { label: "urineren", re: /urineren/i },
];

function cutoffDate() {
  const d = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

async function findRecentlyChangedApvs() {
  const query = `dcterms.title="algemene plaatselijke verordening" AND dcterms.modified>=${cutoffDate()}`;
  const url = `${CVDR_SRU_URL}?version=1.2&operation=searchRetrieve&x-connection=CVDR&maximumRecords=100&query=${encodeURIComponent(query)}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`cvdr_sru_failed (${res.status})`);
  const xml = await res.text();

  if (xml.includes("<diagnostics")) {
    throw new Error(`cvdr_sru_diagnostic: ${xml.slice(0, 300)}`);
  }

  // Cheap regex extraction rather than pulling in an XML parser dependency for
  // one well-known, stable response shape.
  const records = xml.split("<record>").slice(1);
  const results = [];
  for (const chunk of records) {
    const type = /<dcterms:type scheme="overheidop:Rubriek">([^<]*)<\/dcterms:type>/.exec(chunk)?.[1];
    if (type !== APV_TYPE) continue;

    const identifier = /<dcterms:identifier>([^<]*)<\/dcterms:identifier>/.exec(chunk)?.[1];
    const gemeente = /<dcterms:creator[^>]*>([^<]*)<\/dcterms:creator>/.exec(chunk)?.[1];
    const modified = /<dcterms:modified>([^<]*)<\/dcterms:modified>/.exec(chunk)?.[1];
    const xmlUrl = /<publicatieurl_xml>([^<]*)<\/publicatieurl_xml>/.exec(chunk)?.[1];
    const preferredUrl = /<preferred_url>([^<]*)<\/preferred_url>/.exec(chunk)?.[1];

    if (identifier && gemeente && xmlUrl && preferredUrl) {
      results.push({ identifier, gemeente, modified, xmlUrl, preferredUrl });
    }
  }
  return results;
}

function extractText(xml) {
  return xml
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// The app's default logic already assumes the VNG model scope: verboden binnen de
// bebouwde kom, toegestaan daarbuiten. A wildplas-clause that stays within that scope
// needs no action. What's actually worth a human's attention is a clause that reads
// differently — e.g. it names a specific area outside the kom (like Den Haag's
// Haagse Bos), drops the bebouwde-kom qualifier entirely, or otherwise broadens/
// narrows the default.
//
// Two ways a clause deviates, both checked against the FULL TEXT OF THE ARTICLE
// the match sits in (not a flat character window around the match — an earlier
// version used a window and it bled into unrelated neighbouring articles,
// producing false positives from e.g. an adjacent "straatvegen" clause that
// happens to also say "door het college aangewezen"):
//   1. "bebouwde kom" doesn't appear in the article at all — the clause likely
//      doesn't use the standard qualifier.
//   2. "bebouwde kom" DOES appear, but the article ALSO extends the ban to
//      "buiten de bebouwde kom" in a college/burgemeester-aangewezen area — the
//      VNG model text stays silent outside the kom, so a delegated extra area
//      is a real deviation even though "bebouwde kom" is present. This is the
//      Bodegraven-Reeuwijk pattern (article 4:8: "verboden binnen de bebouwde
//      kom ... alsmede buiten de bebouwde kom in een door het college
//      aangewezen gebied") — a plain "is bebouwde kom nearby?" check misses it
//      because the phrase IS nearby, just not exclusively.
const BEBOUWDE_KOM_RE = /bebouwde kom/i;
const OUTSIDE_KOM_DELEGATION_RE = /buiten de bebouwde kom[\s\S]{0,80}aangewezen|aangewezen[\s\S]{0,80}buiten de bebouwde kom/i;

// CVDR full text renders article headers as e.g. "Artikel 4:8" (sometimes with a
// letter suffix like "4:8a") or the older "Artikel 4.8" style. Used both to bound
// the article text around a match and to tell a reviewer which article a
// review-worthy match sits in, since the flat XML->text extraction otherwise
// loses that structure.
const ARTICLE_RE = /Artikel\s*\d+[:.]\d+[a-z]?/gi;
const ARTICLE_LOOKBACK = 2000;

function nearestArticle(text, matchIndex) {
  const windowStart = Math.max(0, matchIndex - ARTICLE_LOOKBACK);
  const before = text.slice(windowStart, matchIndex);
  const found = [...before.matchAll(ARTICLE_RE)];
  return found.length > 0 ? found[found.length - 1][0] : null;
}

// Returns the [start, end) span of the article containing matchIndex — from its
// own "Artikel X:Y" header up to (but not including) the next one, or end of
// text if it's the last article.
function articleBounds(text, matchIndex) {
  const headers = [...text.matchAll(ARTICLE_RE)];
  let start = 0;
  let end = text.length;
  for (let i = 0; i < headers.length; i++) {
    if (headers[i].index <= matchIndex) {
      start = headers[i].index;
      end = i + 1 < headers.length ? headers[i + 1].index : text.length;
    } else {
      break;
    }
  }
  return [start, end];
}

function findWildplasMentions(text) {
  const hits = [];
  for (const { label, re } of WILDPLAS_PATTERNS) {
    const match = re.exec(text);
    if (!match) continue;
    const snippetStart = Math.max(0, match.index - 150);
    const snippetEnd = Math.min(text.length, match.index + match[0].length + 150);

    const [articleStart, articleEnd] = articleBounds(text, match.index);
    const articleText = text.slice(articleStart, articleEnd);
    const hasBebouwdeKom = BEBOUWDE_KOM_RE.test(articleText);
    const hasOutsideKomDelegation = OUTSIDE_KOM_DELEGATION_RE.test(articleText);
    const matchesStandardScope = hasBebouwdeKom && !hasOutsideKomDelegation;

    hits.push({
      keyword: label,
      article: nearestArticle(text, match.index),
      snippet: text.slice(snippetStart, snippetEnd).trim(),
      reviewWorthy: !matchesStandardScope,
    });
  }
  return hits;
}

async function checkApvText(apv) {
  const res = await fetch(apv.xmlUrl);
  if (!res.ok) return { ...apv, error: `fetch_failed (${res.status})` };
  const xml = await res.text();
  const text = extractText(xml);
  const hits = findWildplasMentions(text);
  return { ...apv, hits };
}

export async function GET(request) {
  const authHeader = request.headers.get("authorization");
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    const candidates = await findRecentlyChangedApvs();
    const checked = await Promise.all(candidates.map(checkApvText));

    const findings = checked
      .map((c) => ({ ...c, hits: (c.hits || []).filter((h) => h.reviewWorthy) }))
      .filter((c) => c.hits.length > 0);
    const standard = checked.filter((c) => c.hits?.length > 0 && c.hits.every((h) => !h.reviewWorthy));
    const errors = checked.filter((c) => c.error);

    const findingsPayload = findings.map((f) => ({
      gemeente: f.gemeente,
      modified: f.modified,
      apv_url: f.preferredUrl,
      matches: f.hits,
    }));

    for (const f of findingsPayload) {
      console.log("APV_WATCH_FINDING", JSON.stringify(f));
    }

    const alert = await sendFindingsAlert(findingsPayload);
    if (findingsPayload.length > 0 && !alert.sent) {
      console.error("apv_watch_alert_not_sent", alert.reason);
    }

    return NextResponse.json({
      checkedCount: checked.length,
      findings: findingsPayload,
      alertSent: alert.sent,
      standardScopeConfirmed: standard.map((s) => s.gemeente),
      errors: errors.map((e) => ({ gemeente: e.gemeente, error: e.error })),
    });
  } catch (err) {
    console.error("apv_watch_failed", err);
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}

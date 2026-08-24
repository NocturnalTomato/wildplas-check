import { NextResponse } from "next/server";

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
// narrows the default. We approximate that by checking whether "bebouwde kom" shows
// up near the match: if it doesn't, the clause likely deviates from the model text.
const BEBOUWDE_KOM_RE = /bebouwde kom/i;
const REVIEW_WINDOW = 400;

function findWildplasMentions(text) {
  const hits = [];
  for (const { label, re } of WILDPLAS_PATTERNS) {
    const match = re.exec(text);
    if (!match) continue;
    const snippetStart = Math.max(0, match.index - 150);
    const snippetEnd = Math.min(text.length, match.index + match[0].length + 150);

    const windowStart = Math.max(0, match.index - REVIEW_WINDOW);
    const windowEnd = Math.min(text.length, match.index + match[0].length + REVIEW_WINDOW);
    const matchesStandardScope = BEBOUWDE_KOM_RE.test(text.slice(windowStart, windowEnd));

    hits.push({
      keyword: label,
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

    for (const f of findings) {
      console.log(
        "APV_WATCH_FINDING",
        JSON.stringify({
          gemeente: f.gemeente,
          modified: f.modified,
          apv_url: f.preferredUrl,
          matches: f.hits,
        })
      );
    }

    return NextResponse.json({
      checkedCount: checked.length,
      findings: findings.map((f) => ({
        gemeente: f.gemeente,
        modified: f.modified,
        apv_url: f.preferredUrl,
        matches: f.hits,
      })),
      standardScopeConfirmed: standard.map((s) => s.gemeente),
      errors: errors.map((e) => ({ gemeente: e.gemeente, error: e.error })),
    });
  } catch (err) {
    console.error("apv_watch_failed", err);
    return NextResponse.json({ error: String(err.message || err) }, { status: 500 });
  }
}

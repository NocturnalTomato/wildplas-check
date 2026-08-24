// One-time backfill: scans ALL currently-in-force gemeente APVs (not just
// recently-changed ones, unlike app/api/cron/apv-watch/route.js) for
// wildplassen-related clauses that deviate from the standard VNG scope
// ("verboden binnen de bebouwde kom"). Writes findings to a JSON file for
// human review. Does NOT touch lib/exceptions.json — see AGENTS.md /
// apv-watch/route.js for why that stays a manual step.
//
// Run with: node scripts/apv-backfill.mjs

import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const CVDR_SRU_URL = "https://zoekservice.overheid.nl/sru/Search";
const APV_TYPE = "algemeen verbindend voorschrift (verordening)";
const PAGE_SIZE = 100;
const FETCH_CONCURRENCY = 8;

const WILDPLAS_PATTERNS = [
  { label: "wildplassen", re: /wildplas\w*/i },
  { label: "natuurlijke behoefte", re: /natuurlijke behoefte/i },
  { label: "urineren", re: /urineren/i },
];

// See app/api/cron/apv-watch/route.js for the reasoning behind these two checks
// (kept in sync with that file — this script duplicates its scan logic since it
// runs standalone outside the Next.js app).
const BEBOUWDE_KOM_RE = /bebouwde kom/i;
const OUTSIDE_KOM_DELEGATION_RE = /buiten de bebouwde kom[\s\S]{0,80}aangewezen|aangewezen[\s\S]{0,80}buiten de bebouwde kom/i;
const ARTICLE_RE = /Artikel\s*\d+[:.]\d+[a-z]?/gi;
const ARTICLE_LOOKBACK = 2000;

// Unlike the daily cron's dcterms.modified>=cutoff filter, this queries every
// APV that is valid as of today (overheidrg.datumGeldendOp), then paginates
// through all pages (SRU maximumRecords caps at 100 per request).
async function findAllApvs() {
  const today = new Date().toISOString().slice(0, 10);
  const query = `dcterms.title="algemene plaatselijke verordening" AND overheidrg.datumGeldendOp=${today}`;

  const results = [];
  let startRecord = 1;
  let total = null;

  while (total === null || startRecord <= total) {
    const url = `${CVDR_SRU_URL}?version=1.2&operation=searchRetrieve&x-connection=CVDR&maximumRecords=${PAGE_SIZE}&startRecord=${startRecord}&query=${encodeURIComponent(query)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`cvdr_sru_failed (${res.status}) at startRecord=${startRecord}`);
    const xml = await res.text();
    if (xml.includes("<diagnostics")) {
      throw new Error(`cvdr_sru_diagnostic at startRecord=${startRecord}: ${xml.slice(0, 300)}`);
    }

    if (total === null) {
      total = parseInt(/<numberOfRecords>(\d+)</.exec(xml)?.[1] ?? "0", 10);
      console.log(`CVDR reports ${total} title matches; paginating in batches of ${PAGE_SIZE}...`);
    }

    const records = xml.split("<record>").slice(1);
    if (records.length === 0) break;

    for (const chunk of records) {
      const type = /<dcterms:type scheme="overheidop:Rubriek">([^<]*)<\/dcterms:type>/.exec(chunk)?.[1];
      const title = /<dcterms:title>([^<]*)<\/dcterms:title>/
        .exec(chunk)?.[1]
        ?.replace(/\s+/g, " ")
        .trim();
      const identifier = /<dcterms:identifier>([^<]*)<\/dcterms:identifier>/.exec(chunk)?.[1];
      const gemeente = /<dcterms:creator[^>]*>([^<]*)<\/dcterms:creator>/.exec(chunk)?.[1];
      const modified = /<dcterms:modified>([^<]*)<\/dcterms:modified>/.exec(chunk)?.[1];
      const xmlUrl = /<publicatieurl_xml>([^<]*)<\/publicatieurl_xml>/.exec(chunk)?.[1];
      const preferredUrl = /<preferred_url>([^<]*)<\/preferred_url>/.exec(chunk)?.[1];

      // Rubriek alone isn't enough: aanwijzingsbesluiten, nadere regels and
      // mandaatbesluiten that merely reference "de Algemene plaatselijke
      // verordening" in their own title also carry this Rubriek value. The
      // actual APV's title always *starts with* the phrase; related
      // instruments have it appear later in the title.
      const isMainApv = title && title.toLowerCase().startsWith("algemene plaatselijke verordening");

      if (isMainApv && type === APV_TYPE && identifier && gemeente && xmlUrl && preferredUrl) {
        results.push({ identifier, gemeente, title, modified, xmlUrl, preferredUrl });
      }
    }

    startRecord += PAGE_SIZE;
  }

  return results;
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
  try {
    const res = await fetch(apv.xmlUrl);
    if (!res.ok) return { ...apv, error: `fetch_failed (${res.status})` };
    const xml = await res.text();
    const text = extractText(xml);
    const hits = findWildplasMentions(text);
    return { ...apv, hits };
  } catch (err) {
    return { ...apv, error: String(err.message || err) };
  }
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function main() {
  console.log("Fetching all currently-valid gemeente APVs from CVDR...");
  const apvs = await findAllApvs();
  console.log(`Found ${apvs.length} APVs across ${new Set(apvs.map((a) => a.gemeente)).size} gemeentes.`);

  console.log("Scanning full text for wildplassen-related clauses...");
  const checked = await mapWithConcurrency(apvs, FETCH_CONCURRENCY, checkApvText);

  const errors = checked.filter((c) => c.error);
  const findings = checked
    .map((c) => ({ ...c, hits: (c.hits || []).filter((h) => h.reviewWorthy) }))
    .filter((c) => c.hits.length > 0);
  const standard = checked.filter((c) => c.hits?.length > 0 && c.hits.every((h) => !h.reviewWorthy));

  const output = findings.map((f) => ({
    gemeente: f.gemeente,
    title: f.title,
    modified: f.modified,
    apv_url: f.preferredUrl,
    matches: f.hits.map((h) => ({ keyword: h.keyword, article: h.article, snippet: h.snippet })),
  }));

  const outPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "apv-backfill-findings.json");
  await writeFile(outPath, JSON.stringify(output, null, 2), "utf-8");

  console.log("\n--- Backfill report ---");
  console.log(`Scanned:  ${checked.length} APVs`);
  console.log(`Errors:   ${errors.length}${errors.length ? " (" + errors.map((e) => e.gemeente).join(", ") + ")" : ""}`);
  console.log(`Standard scope confirmed (no action needed): ${standard.length}`);
  console.log(`Findings requiring review: ${findings.length}`);
  if (findings.length > 0) {
    console.log("\nGemeentes with a deviating wildplassen clause:");
    for (const f of findings) {
      console.log(`  - ${f.gemeente}: ${f.hits.map((h) => `${h.keyword} (${h.article ?? "no article found"})`).join("; ")}`);
    }
  }
  console.log(`\nFull findings written to ${outPath}`);
}

main().catch((err) => {
  console.error("apv_backfill_failed", err);
  process.exit(1);
});

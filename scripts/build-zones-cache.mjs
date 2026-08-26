// Builds lib/data/zones-nl.json — a simplified, nationwide snapshot of every
// bebouwde-kom ("kern") polygon in the Netherlands, plus which ones fall in a
// gemeente whose APV extends the wildplas-verbod outside the kom too. Run
// weekly (see .github/workflows/refresh-zones-cache.yml) so /api/zones can
// serve straight from this file instead of hitting PDOK live on every
// request — that per-request PDOK round trip (plus, until recently, a
// reverse-geocode call per polygon) was the actual cause of the slow load.
//
// Usage: node scripts/build-zones-cache.mjs
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import exceptions from "../lib/exceptions.json" with { type: "json" };
import { simplifyGeometry, roundCoordinates, pointInGeometry, approxCentroid } from "../lib/geo.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_PATH = path.join(__dirname, "..", "lib", "data", "zones-nl.json");

const TOP10NL_BASE_URL = "https://api.pdok.nl/kadaster/brt-top10nl/ogc/v1/collections";
const TOP10NL_COLLECTIONS = ["plaats_vlak", "plaats_multivlak"];
const KERN_TYPEGEBIED = new Set(["woonkern", "deelkern", "gehucht", "industriekern"]);

const BESTUURLIJKE_GEBIEDEN_URL =
  "https://api.pdok.nl/kadaster/bestuurlijkegebieden/ogc/v1/collections/gemeentegebied/items";

// Simplification tuning — see the size comparison this was picked from: at
// tolerance 0.001 (~110m) + 4 decimal digits (~11m), the full nationwide set
// comes out to ~2.4MB raw / ~0.6MB gzipped. Precision loss here only affects
// the map's visual shading; /api/check still queries PDOK live per-point at
// full precision for the actual yes/no answer.
const SIMPLIFY_TOLERANCE_DEG = 0.001;
const ROUND_DIGITS = 4;

function firstProp(props, keys) {
  for (const k of keys) {
    if (props[k] !== undefined && props[k] !== null) return props[k];
  }
  return null;
}

function isTruthyFlag(value) {
  return value === true || value === "ja" || value === "true";
}

async function fetchAllPages(url, { headers } = {}) {
  const all = [];
  let next = url;
  while (next) {
    const res = await fetch(next, { headers });
    if (!res.ok) throw new Error(`fetch_failed (${next} -> ${res.status})`);
    const data = await res.json();
    all.push(...(data.features || []));
    next = data.links?.find((l) => l.rel === "next")?.href || null;
  }
  return all;
}

async function fetchAllKernFeatures() {
  const results = await Promise.all(
    TOP10NL_COLLECTIONS.map((collection) =>
      fetchAllPages(`${TOP10NL_BASE_URL}/${collection}/items?f=json&limit=1000`, {
        headers: { Accept: "application/geo+json" },
      })
    )
  );
  return results.flat().filter((f) => KERN_TYPEGEBIED.has(f.properties?.typegebied));
}

// Only fetch boundaries for gemeentes whose APV bans wildplassen with no
// "binnen de bebouwde kom" qualifier (see exceptions.json's own note on how
// this list was researched) — small-area (plaats_bevat/center-scoped)
// entries stay a /api/check-only nuance, too specific to shade as a whole
// kern polygon.
function gemeenteWideBanNames() {
  return exceptions.areas
    .filter((a) => a.allowed === false && !a.plaats_bevat && !a.center)
    .map((a) => a.gemeente);
}

// The API's `naam` filter is an exact-match enum (case-sensitive, and Dutch
// gemeente names have irregular capitalization — "'s-Gravenhage", "Bergen
// (L)", "Nuenen, Gerwen en Nederwetten") — so rather than guess the correct
// casing per name, fetch all ~342 gemeentes once and match case-insensitively.
async function fetchAllGemeenteBoundaries() {
  const res = await fetch(`${BESTUURLIJKE_GEBIEDEN_URL}?f=json&limit=1000`);
  if (!res.ok) throw new Error(`gemeente_boundaries_failed (${res.status})`);
  const data = await res.json();
  return data.features || [];
}

async function main() {
  console.log("Fetching gemeente boundaries for extra-restriction gemeentes...");
  const banNames = gemeenteWideBanNames();
  const allGemeenten = await fetchAllGemeenteBoundaries();
  const resolvedBoundaries = banNames
    .map((naam) => {
      const feature = allGemeenten.find((f) => f.properties?.naam?.toLowerCase() === naam.toLowerCase());
      // displayNaam keeps PDOK's own capitalization (e.g. "Capelle aan den
      // IJssel") for the tooltip; naam stays the exceptions.json-style
      // lowercase key used only for the missing-boundary check below.
      return feature ? { naam, displayNaam: feature.properties.naam, geometry: feature.geometry } : null;
    })
    .filter(Boolean);
  const missing = banNames.filter((naam) => !resolvedBoundaries.some((b) => b.naam === naam));
  if (missing.length > 0) {
    console.warn("WARNING: no boundary found for:", missing.join(", "));
  }
  console.log(`Resolved ${resolvedBoundaries.length}/${banNames.length} gemeente boundaries.`);

  console.log("Fetching all kern polygons nationwide (this takes a while)...");
  const features = await fetchAllKernFeatures();
  console.log(`Fetched ${features.length} kern features.`);

  console.log("Simplifying, rounding, and tagging extra-restriction zones...");
  const outFeatures = features.map((f) => {
    const inKom = isTruthyFlag(firstProp(f.properties || {}, ["bebouwdekom", "BEBOUWDEKOM", "Bebouwdekom"]));
    const plaats = firstProp(f.properties || {}, ["naamnl", "naam", "NAAM", "naamNL"]);

    let extraRestriction = false;
    let gemeente = null;
    if (!inKom) {
      const centroid = approxCentroid(f.geometry);
      if (centroid) {
        const match = resolvedBoundaries.find((b) => pointInGeometry(centroid.lon, centroid.lat, b.geometry));
        if (match) {
          gemeente = match.displayNaam;
          extraRestriction = true;
        }
      }
    }

    const simplified = simplifyGeometry(f.geometry, SIMPLIFY_TOLERANCE_DEG);
    const geometry = { type: simplified.type, coordinates: roundCoordinates(simplified.coordinates, ROUND_DIGITS) };

    return {
      type: "Feature",
      geometry,
      properties: { inKom, plaats, gemeente, extraRestriction },
    };
  });

  const output = { type: "FeatureCollection", generatedAt: new Date().toISOString(), features: outFeatures };
  const json = JSON.stringify(output);
  await writeFile(OUT_PATH, json);
  console.log(`Wrote ${outFeatures.length} features to ${OUT_PATH} (${(json.length / 1024 / 1024).toFixed(2)} MB).`);
}

main().catch((err) => {
  console.error("build-zones-cache failed:", err);
  process.exit(1);
});

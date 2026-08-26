// Shared PDOK BRT TOP10NL access — bebouwde-kom ("kern") polygons. Used both
// for the single-point check (/api/check) and the zone-shading overlay on
// the explore map (/api/zones). See app/api/check/route.js for background on
// why only "kern"-level polygons carry a meaningful bebouwdekom flag.
const TOP10NL_BASE_URL = "https://api.pdok.nl/kadaster/brt-top10nl/ogc/v1/collections";
const TOP10NL_COLLECTIONS = ["plaats_vlak", "plaats_multivlak"];
const KERN_TYPEGEBIED = new Set(["woonkern", "deelkern", "gehucht", "industriekern"]);

// PDOK Locatieserver — free-text/reverse geocoding, no API key required.
const LOCATIESERVER_REVERSE_URL = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/reverse";

// Neither plaats_vlak nor plaats_multivlak carries the gemeente name, so
// resolving it (for /api/check's own point, or for a kern polygon's
// approximate centroid in /api/zones) always needs this separate call.
export async function reverseGeocodeGemeente(lat, lon) {
  const url = `${LOCATIESERVER_REVERSE_URL}?lat=${lat}&lon=${lon}&rows=1&fl=gemeentenaam`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  return data?.response?.docs?.[0]?.gemeentenaam || null;
}

export function firstProp(props, keys) {
  for (const k of keys) {
    if (props[k] !== undefined && props[k] !== null) return props[k];
  }
  return null;
}

// PDOK's OGC API Features returns bebouwdekom as the string "ja"/"nee", not a boolean.
export function isTruthyFlag(value) {
  return value === true || value === "ja" || value === "true";
}

async function fetchKernFeatures(collection, bbox, limit) {
  const url = `${TOP10NL_BASE_URL}/${collection}/items?f=json&bbox=${bbox}&limit=${limit}`;
  const res = await fetch(url, { headers: { Accept: "application/geo+json" } });
  if (!res.ok) throw new Error(`top10nl_failed (${collection} ${res.status})`);
  const data = await res.json();
  const features = data?.features || [];
  return features.filter((f) => KERN_TYPEGEBIED.has(f.properties?.typegebied));
}

export async function fetchKernFeaturesInBbox(bbox, limit = 50) {
  const results = await Promise.all(
    TOP10NL_COLLECTIONS.map((collection) => fetchKernFeatures(collection, bbox, limit))
  );
  return results.flat();
}

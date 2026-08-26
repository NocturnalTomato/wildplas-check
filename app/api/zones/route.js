import { NextResponse } from "next/server";
import zonesCache from "../../../lib/data/zones-nl.json";

// Feeds the zone-shading overlay on the explore map: returns the bebouwde-kom
// ("kern") polygons within a bounding box as GeoJSON, tagged with whether
// each one is inside the kom (wildplassen not allowed) or not (allowed), and
// whether it falls in a gemeente whose APV bans wildplassen outside the kom
// too (extraRestriction).
//
// Serves straight from lib/data/zones-nl.json — a nationwide snapshot built
// once a week by scripts/build-zones-cache.mjs (see .github/workflows/
// refresh-zones-cache.yml) — rather than querying PDOK live per request.
// That live per-request round trip (PDOK TOP10NL fetch, plus formerly a
// reverse-geocode call per polygon for extraRestriction) was the actual
// cause of the slow load; filtering an in-memory array by bbox is a
// sub-millisecond operation, no network involved at all.
//
// The cache's own precision loss (polygons simplified for file size, see the
// build script) only affects this visual overlay — /api/check still queries
// PDOK live at full precision for the actual per-point answer.

function bboxesIntersect(a, b) {
  return a.minLon <= b.maxLon && a.maxLon >= b.minLon && a.minLat <= b.maxLat && a.maxLat >= b.minLat;
}

// Cheap bounding-box (not exact polygon) intersection test — good enough for
// deciding whether a feature is worth sending to the client, which then only
// draws whatever's actually in view anyway. Computed lazily per feature
// rather than precomputed at build time, since this loop is already trivially
// fast against a ~4-5k feature in-memory array.
function featureBbox(geometry) {
  const rings = geometry.type === "Polygon" ? geometry.coordinates : geometry.coordinates.flat();
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return { minLon, maxLon, minLat, maxLat };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const bboxParam = searchParams.get("bbox");
  if (!bboxParam) {
    return NextResponse.json({ error: "missing bbox" }, { status: 400 });
  }

  const parts = bboxParam.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    return NextResponse.json({ error: "invalid bbox" }, { status: 400 });
  }
  const [minLon, minLat, maxLon, maxLat] = parts;
  const requestBbox = { minLon, minLat, maxLon, maxLat };

  const features = zonesCache.features
    .filter((f) => bboxesIntersect(featureBbox(f.geometry), requestBbox))
    .map((f) => ({ type: "Feature", geometry: f.geometry, properties: f.properties }));

  return NextResponse.json({ type: "FeatureCollection", features });
}

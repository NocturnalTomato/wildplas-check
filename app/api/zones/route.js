import { NextResponse } from "next/server";
import { fetchKernFeaturesInBbox, firstProp, isTruthyFlag } from "../../../lib/top10nl.js";

// Guards against huge/abusive bbox requests. The client only fetches zones
// once zoomed in fairly close (see ExploreMap's ZONE_MIN_ZOOM), so a normal
// browser viewport never gets close to this — it's a server-side safety net,
// not the primary gate.
const MAX_SPAN_DEG = 0.35;

// Feeds the zone-shading overlay on the explore map: returns the bebouwde-kom
// ("kern") polygons within a bounding box as GeoJSON, tagged with whether
// each one is inside the kom (wildplassen not allowed) or not (allowed).
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
  if (maxLon - minLon > MAX_SPAN_DEG || maxLat - minLat > MAX_SPAN_DEG) {
    return NextResponse.json({ error: "bbox_too_large" }, { status: 400 });
  }

  try {
    const features = await fetchKernFeaturesInBbox(bboxParam, 300);
    return NextResponse.json({
      type: "FeatureCollection",
      features: features.map((f) => ({
        type: "Feature",
        geometry: f.geometry,
        properties: {
          inKom: isTruthyFlag(firstProp(f.properties || {}, ["bebouwdekom", "BEBOUWDEKOM", "Bebouwdekom"])),
          plaats: firstProp(f.properties || {}, ["naamnl", "naam", "NAAM", "naamNL"]),
        },
      })),
    });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 502 });
  }
}

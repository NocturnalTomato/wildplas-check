// Small dependency-free geometry helpers shared between the nationwide zones
// cache builder (scripts/build-zones-cache.mjs) and, for point-in-polygon,
// anything that needs to test containment against a fetched boundary.

function perpendicularDistance(p, a, b) {
  const [x, y] = p;
  const [x1, y1] = a;
  const [x2, y2] = b;
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) return Math.hypot(x - x1, y - y1);
  const t = ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy);
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(x - cx, y - cy);
}

// Ramer-Douglas-Peucker. `tolerance` is in the same units as the input
// coordinates (degrees, here) — points within `tolerance` of the line
// between their neighbours get dropped.
function douglasPeucker(points, tolerance) {
  if (points.length < 3) return points;
  let maxDist = 0;
  let index = 0;
  const first = points[0];
  const last = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], first, last);
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }
  if (maxDist > tolerance) {
    const left = douglasPeucker(points.slice(0, index + 1), tolerance);
    const right = douglasPeucker(points.slice(index), tolerance);
    return left.slice(0, -1).concat(right);
  }
  return [first, last];
}

// Never simplifies a ring down below a triangle (3 distinct points + closing
// point = 4) — protects small kern polygons (a tiny gehucht) from being
// simplified into a degenerate sliver.
function simplifyRing(ring, tolerance) {
  if (ring.length <= 4) return ring;
  const simplified = douglasPeucker(ring, tolerance);
  return simplified.length < 4 ? ring : simplified;
}

export function simplifyGeometry(geometry, tolerance) {
  if (geometry.type === "Polygon") {
    return { type: "Polygon", coordinates: geometry.coordinates.map((r) => simplifyRing(r, tolerance)) };
  }
  if (geometry.type === "MultiPolygon") {
    return {
      type: "MultiPolygon",
      coordinates: geometry.coordinates.map((poly) => poly.map((r) => simplifyRing(r, tolerance))),
    };
  }
  return geometry;
}

// Rounds every coordinate to `digits` decimal places — independent of (and
// stacked on top of) simplifyGeometry's vertex reduction, since it shrinks
// the JSON text size of every remaining vertex too.
export function roundCoordinates(coords, digits) {
  const factor = 10 ** digits;
  if (typeof coords[0] === "number") return coords.map((n) => Math.round(n * factor) / factor);
  return coords.map((c) => roundCoordinates(c, digits));
}

// Even-odd point-in-polygon, applied across every ring of every part of a
// Polygon/MultiPolygon. This is the standard SVG-style "evenodd" fill rule:
// XOR-ing crossing-parity across ALL rings (regardless of exterior/hole or
// which part of a MultiPolygon they belong to) correctly handles holes and
// disjoint parts without needing to track that structure explicitly.
export function pointInGeometry(lon, lat, geometry) {
  const rings = geometry.type === "Polygon" ? geometry.coordinates : geometry.coordinates.flat();
  let inside = false;
  for (const ring of rings) {
    let crossed = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      const intersect = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
      if (intersect) crossed = !crossed;
    }
    if (crossed) inside = !inside;
  }
  return inside;
}

// Cheap "vertex average" centroid — doesn't need to be exact, just needs to
// land inside the settlement for a point-in-polygon gemeente-boundary test.
export function approxCentroid(geometry) {
  const ring = geometry.type === "Polygon" ? geometry.coordinates[0] : geometry.coordinates[0]?.[0];
  if (!ring || ring.length === 0) return null;
  let sumLon = 0;
  let sumLat = 0;
  for (const [lon, lat] of ring) {
    sumLon += lon;
    sumLat += lat;
  }
  return { lon: sumLon / ring.length, lat: sumLat / ring.length };
}

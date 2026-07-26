import { NextResponse } from "next/server";
import exceptions from "../../../lib/exceptions.json";

// PDOK Locatieserver — free-text geocoding, no API key required.
const LOCATIESERVER_URL = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/free";

// PDOK BRT TOP10NL WFS — nationwide topographic registry, updated periodically.
// The "plaats" (vlakken) layer carries a BEBOUWDEKOM boolean attribute per polygon.
// NOTE: verify the exact typeName via a DescribeFeatureType call against this
// service before relying on this in production — PDOK layer names occasionally
// change between TOP10NL releases. Fallback below degrades gracefully if it 404s.
const TOP10NL_WFS_URL = "https://service.pdok.nl/brt/top10nl/wfs/v1_0";
const TOP10NL_TYPENAME = "top10nl:plaats";

async function geocode(address) {
  const url = `${LOCATIESERVER_URL}?q=${encodeURIComponent(address)}&rows=1&fl=weergavenaam,centroide_ll`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("geocode_failed");
  const data = await res.json();
  const doc = data?.response?.docs?.[0];
  if (!doc?.centroide_ll) throw new Error("no_match");
  // centroide_ll looks like "POINT(4.897070 52.377956)" (lon lat)
  const match = /POINT\(([-\d.]+)\s+([-\d.]+)\)/.exec(doc.centroide_ll);
  if (!match) throw new Error("bad_geometry");
  return {
    lon: parseFloat(match[1]),
    lat: parseFloat(match[2]),
    label: doc.weergavenaam,
  };
}

async function lookupBebouwdeKom(lat, lon) {
  const cql = `INTERSECTS(geometrie,POINT(${lon} ${lat}))`;
  const url =
    `${TOP10NL_WFS_URL}?service=WFS&version=2.0.0&request=GetFeature` +
    `&typeName=${encodeURIComponent(TOP10NL_TYPENAME)}` +
    `&outputFormat=json&srsName=EPSG:4326&count=1` +
    `&CQL_FILTER=${encodeURIComponent(cql)}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error("wfs_failed");
  const data = await res.json();
  const feature = data?.features?.[0];
  if (!feature) {
    // No plaats-polygon at this point at all -> outside any bebouwde kom.
    return { insideKom: false, gemeente: null, plaats: null };
  }
  const props = feature.properties || {};
  return {
    insideKom: props.BEBOUWDEKOM === true || props.bebouwdekom === true,
    gemeente: props.GEMEENTENAAM || props.gemeentenaam || null,
    plaats: props.NAAM || props.naam || null,
  };
}

function checkExceptions(gemeente, plaats) {
  if (!gemeente && !plaats) return null;
  const g = (gemeente || "").toLowerCase();
  const p = (plaats || "").toLowerCase();
  for (const area of exceptions.areas) {
    if (area.gemeente === g && (!area.plaats_bevat || p.includes(area.plaats_bevat))) {
      return area;
    }
  }
  return null;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const address = searchParams.get("address");
  let lat = searchParams.get("lat");
  let lon = searchParams.get("lon");
  let label = null;

  try {
    if (address) {
      const geo = await geocode(address);
      lat = geo.lat;
      lon = geo.lon;
      label = geo.label;
    } else {
      lat = parseFloat(lat);
      lon = parseFloat(lon);
    }

    if (!lat || !lon || Number.isNaN(lat) || Number.isNaN(lon)) {
      return NextResponse.json(
        { allowed: null, reason: "Geen geldige locatie meegegeven." },
        { status: 400 }
      );
    }

    const { insideKom, gemeente, plaats } = await lookupBebouwdeKom(lat, lon);

    const exception = checkExceptions(gemeente, plaats);
    if (exception) {
      return NextResponse.json({
        allowed: exception.allowed,
        reason: exception.note,
        gemeente,
        plaats,
        label,
        source: "exception-list",
      });
    }

    if (insideKom) {
      return NextResponse.json({
        allowed: false,
        reason: `Je bevindt je binnen de bebouwde kom${plaats ? ` van ${plaats}` : ""}. De meeste gemeentelijke APV's verbieden wildplassen hier.`,
        gemeente,
        plaats,
        label,
        source: "top10nl",
      });
    }

    return NextResponse.json({
      allowed: true,
      reason: `Je bevindt je buiten de bebouwde kom. De meeste APV's regelen het verbod alleen binnen de bebouwde kom, dus hier mag het doorgaans wel.`,
      gemeente,
      plaats,
      label,
      source: "top10nl",
    });
  } catch (err) {
    return NextResponse.json({
      allowed: null,
      reason: "Kon de locatie niet controleren (databron tijdelijk niet bereikbaar).",
      error: String(err.message || err),
    });
  }
}

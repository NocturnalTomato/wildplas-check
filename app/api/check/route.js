import { NextResponse } from "next/server";
import exceptions from "../../../lib/exceptions.json";

// PDOK Locatieserver — free-text geocoding, no API key required.
const LOCATIESERVER_URL = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/free";

// PDOK BRT TOP10NL — modern OGC API Features (replaces the old WFS service, which
// no longer resolves reliably). Collection "plaats_vlak" carries a bebouwdekom
// boolean per polygon. Core OGC API Features only guarantees bbox filtering (no
// point-intersects filter everywhere), so we query a small bbox around the point
// and treat "any returned feature flagged bebouwdekom=true" as inside the kom.
const TOP10NL_ITEMS_URL =
  "https://api.pdok.nl/kadaster/brt-top10nl/ogc/v1/collections/plaats_vlak/items";
const BBOX_EPS = 0.0006; // roughly ~65m, small relative to kom-polygon scale

async function geocode(address) {
  const url = `${LOCATIESERVER_URL}?q=${encodeURIComponent(address)}&rows=1&fl=weergavenaam,centroide_ll`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`geocode_failed (${res.status})`);
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

function firstProp(props, keys) {
  for (const k of keys) {
    if (props[k] !== undefined && props[k] !== null) return props[k];
  }
  return null;
}

async function lookupBebouwdeKom(lat, lon) {
  const bbox = [lon - BBOX_EPS, lat - BBOX_EPS, lon + BBOX_EPS, lat + BBOX_EPS].join(",");
  const url = `${TOP10NL_ITEMS_URL}?f=json&bbox=${bbox}&limit=10`;

  const res = await fetch(url, { headers: { Accept: "application/geo+json" } });
  if (!res.ok) throw new Error(`top10nl_failed (${res.status})`);
  const data = await res.json();
  const features = data?.features || [];

  if (features.length === 0) {
    // No plaats-polygon anywhere near this point -> outside any bebouwde kom.
    return { insideKom: false, gemeente: null, plaats: null };
  }

  const inKomFeature = features.find((f) => {
    const props = f.properties || {};
    return firstProp(props, ["bebouwdekom", "BEBOUWDEKOM", "Bebouwdekom"]) === true;
  });

  const feature = inKomFeature || features[0];
  const props = feature.properties || {};

  return {
    insideKom: Boolean(inKomFeature),
    gemeente: firstProp(props, ["gemeentenaam", "GEMEENTENAAM", "gemeente"]),
    plaats: firstProp(props, ["naamnl", "naam", "NAAM", "naamNL"]),
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
    console.error("check_failed", err);
    return NextResponse.json({
      allowed: null,
      reason: "Kon de locatie niet controleren (databron tijdelijk niet bereikbaar).",
      error: String(err.message || err),
    });
  }
}

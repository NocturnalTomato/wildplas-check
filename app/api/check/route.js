import { NextResponse } from "next/server";
import exceptions from "../../../lib/exceptions.json";

// PDOK Locatieserver — free-text geocoding, no API key required.
const LOCATIESERVER_URL = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/free";
const LOCATIESERVER_REVERSE_URL = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/reverse";

// PDOK BRT TOP10NL — modern OGC API Features (replaces the old WFS service, which
// no longer resolves reliably). The bebouwde-kom flag lives on settlement-level
// ("kern") polygons: single-part settlements are in "plaats_vlak", multi-part ones
// (e.g. Amsterdam, which has disjoint enclaves/islands) are in "plaats_multivlak".
// Neighbourhood-level polygons (buurt/wijk/stadsdeel), also returned by these
// collections, always carry bebouwdekom="nee" regardless of location and must be
// ignored. Core OGC API Features only guarantees bbox filtering (no point-intersects
// filter everywhere), so we query a small bbox around the point and treat "any
// returned kern-level feature flagged bebouwdekom=ja" as inside the kom.
const TOP10NL_BASE_URL = "https://api.pdok.nl/kadaster/brt-top10nl/ogc/v1/collections";
const TOP10NL_COLLECTIONS = ["plaats_vlak", "plaats_multivlak"];
const KERN_TYPEGEBIED = new Set(["woonkern", "deelkern", "gehucht", "industriekern"]);
const BBOX_EPS = 0.0006; // roughly ~65m, small relative to kom-polygon scale

// Nationwide, government-run explainer of the wildplassen rule (politie.nl) — applies
// everywhere, unlike APV text which is per-gemeente. Used for the two generic outcomes;
// APV exceptions link to their own municipal regulation instead (see exceptions.json).
const POLITIE_WILDPLASSEN_URL = "https://www.politie.nl/informatie/wat-is-wildplassen-en-welke-boete-staat-ervoor.html";

// Landelijke zoekpagina voor gemeentelijke regelgeving (CVDR) — geen betrouwbare
// manier om hier query-parameters op te bouwen die direct naar de juiste APV
// van een specifieke gemeente linken, dus we linken naar de zoekpagina zelf.
const LOKALE_REGELGEVING_URL = "https://lokaleregelgeving.overheid.nl/zoeken";

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

// Neither plaats_vlak nor plaats_multivlak carries the gemeente name, so we
// resolve it separately via reverse geocoding.
async function reverseGeocodeGemeente(lat, lon) {
  const url = `${LOCATIESERVER_REVERSE_URL}?lat=${lat}&lon=${lon}&rows=1&fl=gemeentenaam`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  return data?.response?.docs?.[0]?.gemeentenaam || null;
}

function firstProp(props, keys) {
  for (const k of keys) {
    if (props[k] !== undefined && props[k] !== null) return props[k];
  }
  return null;
}

// PDOK's OGC API Features returns bebouwdekom as the string "ja"/"nee", not a boolean.
function isTruthyFlag(value) {
  return value === true || value === "ja" || value === "true";
}

async function fetchKernFeatures(collection, bbox) {
  const url = `${TOP10NL_BASE_URL}/${collection}/items?f=json&bbox=${bbox}&limit=50`;
  const res = await fetch(url, { headers: { Accept: "application/geo+json" } });
  if (!res.ok) throw new Error(`top10nl_failed (${collection} ${res.status})`);
  const data = await res.json();
  const features = data?.features || [];
  return features.filter((f) => KERN_TYPEGEBIED.has(f.properties?.typegebied));
}

async function lookupBebouwdeKom(lat, lon) {
  const bbox = [lon - BBOX_EPS, lat - BBOX_EPS, lon + BBOX_EPS, lat + BBOX_EPS].join(",");

  const results = await Promise.all(
    TOP10NL_COLLECTIONS.map((collection) => fetchKernFeatures(collection, bbox))
  );
  const features = results.flat();

  if (features.length === 0) {
    // No settlement (kern) polygon anywhere near this point -> outside any bebouwde kom.
    return { insideKom: false, gemeente: null, plaats: null };
  }

  const inKomFeature = features.find((f) => {
    const props = f.properties || {};
    return isTruthyFlag(firstProp(props, ["bebouwdekom", "BEBOUWDEKOM", "Bebouwdekom"]));
  });

  const feature = inKomFeature || features[0];
  const props = feature.properties || {};

  return {
    insideKom: Boolean(inKomFeature),
    plaats: firstProp(props, ["naamnl", "naam", "NAAM", "naamNL"]),
  };
}

// Rough bounding box around the Netherlands (incl. Wadden islands), used to
// short-circuit before hitting PDOK — which only covers NL and would otherwise
// just return "no kern found here" for any location abroad.
const NL_BBOX = { minLat: 50.7, maxLat: 53.7, minLon: 3.2, maxLon: 7.3 };

function isInNetherlands(lat, lon) {
  return (
    lat >= NL_BBOX.minLat &&
    lat <= NL_BBOX.maxLat &&
    lon >= NL_BBOX.minLon &&
    lon <= NL_BBOX.maxLon
  );
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

    if (!isInNetherlands(lat, lon)) {
      return NextResponse.json({
        allowed: null,
        reason: "Deze locatie ligt buiten Nederland. Deze check werkt alleen voor Nederland, dus we weten het hier niet.",
        label,
        source: "out-of-nl",
      });
    }

    const [{ insideKom, plaats }, gemeente] = await Promise.all([
      lookupBebouwdeKom(lat, lon),
      reverseGeocodeGemeente(lat, lon),
    ]);

    const exception = checkExceptions(gemeente, plaats);
    if (exception) {
      return NextResponse.json({
        allowed: exception.allowed,
        reason: exception.note,
        gemeente,
        plaats,
        label,
        source: "exception-list",
        link: exception.apv_url
          ? { url: exception.apv_url, label: exception.apv_label || "Lees de APV-bepaling" }
          : null,
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
        link: { url: POLITIE_WILDPLASSEN_URL, label: "Waarom dit verboden is (politie.nl)" },
      });
    }

    return NextResponse.json({
      allowed: true,
      reason: `Je bevindt je buiten de bebouwde kom${plaats ? ` van ${plaats}` : ""}. De meeste gemeentelijke APV's verbieden wildplassen alleen binnen de bebouwde kom${gemeente ? ` van ${gemeente}` : ""}. We hebben deze locatie ook gecheckt tegen onze lijst met bekende uitzonderingen (gebieden die een gemeente alsnog buiten de kom verbiedt) en daar is niets gevonden — maar check zelf de APV van de gemeente als je het zeker wilt weten.`,
      gemeente,
      plaats,
      label,
      source: "top10nl",
      link: { url: LOKALE_REGELGEVING_URL, label: "Zoek de APV van deze gemeente op" },
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

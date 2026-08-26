import { NextResponse } from "next/server";
import exceptions from "../../../lib/exceptions.json";
import { fetchKernFeaturesInBbox, firstProp, isTruthyFlag, reverseGeocodeGemeente } from "../../../lib/top10nl.js";
import { findWildplasApvLink } from "../../../lib/apvLookup.js";

// PDOK Locatieserver — free-text geocoding, no API key required.
const LOCATIESERVER_URL = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/free";

// PDOK BRT TOP10NL — modern OGC API Features (replaces the old WFS service, which
// no longer resolves reliably). The bebouwde-kom flag lives on settlement-level
// ("kern") polygons: single-part settlements are in "plaats_vlak", multi-part ones
// (e.g. Amsterdam, which has disjoint enclaves/islands) are in "plaats_multivlak".
// Neighbourhood-level polygons (buurt/wijk/stadsdeel), also returned by these
// collections, always carry bebouwdekom="nee" regardless of location and must be
// ignored. Core OGC API Features only guarantees bbox filtering (no point-intersects
// filter everywhere), so we query a small bbox around the point and treat "any
// returned kern-level feature flagged bebouwdekom=ja" as inside the kom.
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

async function lookupBebouwdeKom(lat, lon) {
  const bbox = [lon - BBOX_EPS, lat - BBOX_EPS, lon + BBOX_EPS, lat + BBOX_EPS].join(",");
  const features = await fetchKernFeaturesInBbox(bbox, 50);

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

// Haversine distance in meters — used for small-area exceptions (see below).
function distanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Most exceptions.json entries match on gemeente + a substring of `plaats` (the
// PDOK kern name) — fine for a named area that IS the kern (e.g. Haagse Bos falls
// within Den Haag's own kern). It breaks down for small, specifically-designated
// areas (a JOP, a parking lot, a strip of beach) that share their `plaats` with the
// rest of a village/town: a substring match would wrongly flag the whole place. For
// those, an entry can carry `center` {lat, lon} + `radius_m` instead of
// `plaats_bevat`, matched by actual distance to the point being checked.
function checkExceptions(gemeente, plaats, lat, lon) {
  if (!gemeente && !plaats) return null;
  const g = (gemeente || "").toLowerCase();
  const p = (plaats || "").toLowerCase();
  for (const area of exceptions.areas) {
    if (area.gemeente !== g) continue;
    if (area.center && typeof area.radius_m === "number") {
      if (
        Number.isFinite(lat) &&
        Number.isFinite(lon) &&
        distanceMeters(lat, lon, area.center.lat, area.center.lon) <= area.radius_m
      ) {
        return area;
      }
      continue;
    }
    if (!area.plaats_bevat || p.includes(area.plaats_bevat)) {
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

    const exception = checkExceptions(gemeente, plaats, lat, lon);
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

    // Best-effort: resolve gemeente -> a direct link into its actual, currently
    // in-force APV (deep-linked to the wildplassen article when we can find
    // one) instead of a generic "go search for it yourself" page. Falls back
    // gracefully (below) if the gemeente can't be resolved on CVDR.
    const apvLink = gemeente ? await findWildplasApvLink(gemeente).catch(() => null) : null;

    if (insideKom) {
      const link = apvLink
        ? {
            url: apvLink.url,
            label: apvLink.article
              ? `${apvLink.article} van de APV van ${gemeente}`
              : `APV van ${gemeente}`,
          }
        : { url: POLITIE_WILDPLASSEN_URL, label: "Waarom dit verboden is (politie.nl)" };

      return NextResponse.json({
        allowed: false,
        reason: `Je bevindt je binnen de bebouwde kom${plaats ? ` van ${plaats}` : ""}. De meeste gemeentelijke APV's verbieden wildplassen hier${apvLink?.article ? ` (${apvLink.article})` : ""}.`,
        gemeente,
        plaats,
        label,
        source: "top10nl",
        link,
      });
    }

    const link = apvLink
      ? {
          url: apvLink.url,
          label: apvLink.article
            ? `${apvLink.article} van de APV van ${gemeente}`
            : `APV van ${gemeente}`,
        }
      : { url: LOKALE_REGELGEVING_URL, label: "Zoek de APV van deze gemeente op" };

    return NextResponse.json({
      allowed: true,
      reason: `Je bevindt je buiten de bebouwde kom${plaats ? ` van ${plaats}` : ""}. De meeste gemeentelijke APV's verbieden wildplassen alleen binnen de bebouwde kom${gemeente ? ` van ${gemeente}` : ""}. We hebben deze locatie ook gecheckt tegen onze lijst met bekende uitzonderingen (gebieden die een gemeente alsnog buiten de kom verbiedt) en daar is niets gevonden — maar check zelf de APV van de gemeente als je het zeker wilt weten.`,
      gemeente,
      plaats,
      label,
      source: "top10nl",
      link,
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

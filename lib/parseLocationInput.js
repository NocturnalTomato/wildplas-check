// Parses free-text address-bar input for shortcuts beyond plain PDOK addresses:
// raw "lat, lon" pairs and Google Plus Codes (Open Location Codes).

const PLUS_CODE_ALPHABET = "23456789CFGHJMPQRVWX";

// "52.377956, 4.897070" — the format Google Maps' own "copy coordinates" produces.
export function parseCoordinates(text) {
  const cleaned = text.trim();
  const m = cleaned.match(/^(-?\d{1,3}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)$/);
  if (!m) return null;
  const a = parseFloat(m[1]);
  const b = parseFloat(m[2]);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  if (Math.abs(a) <= 90 && Math.abs(b) <= 180) {
    return { lat: a, lon: b };
  }
  return null;
}

// Decodes a full Plus Code (e.g. "9F4M8QM3+3X" or "9F4M8QM3+3X Amsterdam") to its
// center point. Short codes (missing the leading area digits) aren't supported —
// they need a reference location to disambiguate.
export function parsePlusCode(text) {
  const token = text.trim().split(/\s+/)[0]?.toUpperCase();
  if (!token) return null;
  const fullPattern = /^[23456789CFGHJMPQRVWX]{8}\+[23456789CFGHJMPQRVWX]{2,3}$/;
  if (!fullPattern.test(token)) return null;

  const clean = token.replace("+", "");
  let latLo = -90.0;
  let lonLo = -180.0;
  let latResolution = 400.0;
  let lonResolution = 400.0;

  for (let i = 0; i < clean.length && i < 10; i += 2) {
    latResolution /= 20.0;
    lonResolution /= 20.0;
    latLo += PLUS_CODE_ALPHABET.indexOf(clean[i]) * latResolution;
    lonLo += PLUS_CODE_ALPHABET.indexOf(clean[i + 1]) * lonResolution;
  }

  const lat = latLo + latResolution / 2;
  const lon = lonLo + lonResolution / 2;
  if (Number.isNaN(lat) || Number.isNaN(lon)) return null;
  return { lat, lon };
}

// A Google Maps URL that already carries coordinates (e.g. .../@52.37,4.89,17z).
// Shortened links (maps.app.goo.gl/...) don't embed coordinates until resolved,
// so those are handled server-side via /api/resolve-url.
export function parseGoogleMapsUrl(text) {
  const raw = text.trim();
  if (!/^https?:\/\//i.test(raw)) return null;

  const atMatch = raw.match(/@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
  if (atMatch) return { lat: parseFloat(atMatch[1]), lon: parseFloat(atMatch[2]) };

  const llMatch = raw.match(/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/);
  if (llMatch) return { lat: parseFloat(llMatch[1]), lon: parseFloat(llMatch[2]) };

  try {
    const url = new URL(raw);
    const q = url.searchParams.get("q");
    if (q) {
      const c = parseCoordinates(q);
      if (c) return c;
    }
  } catch {}

  return null;
}

export function isUrl(text) {
  return /^https?:\/\//i.test(text.trim());
}

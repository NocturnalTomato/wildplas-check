"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import "leaflet/dist/leaflet.css";
import { createPinIcon } from "./mapIcons";

const STATUS_LABEL = {
  allowed: "JA",
  "not-allowed": "NEE",
  unknown: "GEEN IDEE",
  loading: "…",
};

// Below this zoom, a viewport bbox covers too much ground for a meaningful
// (and PDOK-friendly) zone fetch — same idea as Google Maps only rendering
// detailed layers once you're zoomed in on a city/town scale.
const ZONE_MIN_ZOOM = 13;
const ZONE_DEBOUNCE_MS = 400;
const ZONE_PAD_FACTOR = 0.15;
// Must stay comfortably under /api/zones' MAX_SPAN_DEG (0.35) — that cap is a
// server-side safety net, this is what actually keeps requests under it. A
// padded viewport at ZONE_MIN_ZOOM on a wide monitor can otherwise exceed the
// server cap, which used to get silently swallowed (see clamp below).
const MAX_BBOX_SPAN_DEG = 0.32;

function statusFromResult(data) {
  if (!data) return "unknown";
  if (data.allowed === true) return "allowed";
  if (data.allowed === false) return "not-allowed";
  return "unknown";
}

// Pads a Leaflet LatLngBounds by a fraction of its own size, so panning a
// little doesn't immediately reveal an untinted edge before the next
// (debounced) zone fetch lands.
function padBounds(bounds, factor) {
  const west = bounds.getWest();
  const east = bounds.getEast();
  const south = bounds.getSouth();
  const north = bounds.getNorth();
  const padLon = (east - west) * factor;
  const padLat = (north - south) * factor;
  return { west: west - padLon, east: east + padLon, south: south - padLat, north: north + padLat };
}

// Shrinks a [min, max] span down to maxSpan around its own center, if needed.
// Used so a wide monitor's padded viewport can never produce a bbox the
// server rejects — it just fetches a slightly smaller area instead of
// failing outright.
function clampSpan(min, max, maxSpan) {
  if (max - min <= maxSpan) return [min, max];
  const center = (min + max) / 2;
  return [center - maxSpan / 2, center + maxSpan / 2];
}

function clampBounds(padded, maxSpan) {
  const [west, east] = clampSpan(padded.west, padded.east, maxSpan);
  const [south, north] = clampSpan(padded.south, padded.north, maxSpan);
  return { west, east, south, north };
}

export default function ExploreMap() {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const LRef = useRef(null);
  const markerRef = useRef(null);
  const zonesGroupRef = useRef(null);
  const zoneFetchAbortRef = useRef(null);
  const zoneDebounceRef = useRef(null);

  const [card, setCard] = useState(null); // { status, lat, lon, label, reason, link }
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [locating, setLocating] = useState(false);
  const [zonesHint, setZonesHint] = useState("zoom-in"); // "zoom-in" | "ready" | null
  const debounceRef = useRef(null);

  async function checkPoint(lat, lon, label) {
    setCard({ status: "loading", lat, lon, label });

    const L = LRef.current;
    if (markerRef.current) {
      markerRef.current.setLatLng([lat, lon]);
      markerRef.current.setIcon(createPinIcon(L, "loading", { pulse: true }));
    } else if (L && mapRef.current) {
      markerRef.current = L.marker([lat, lon], {
        icon: createPinIcon(L, "loading", { pulse: true }),
      }).addTo(mapRef.current);
    }

    try {
      const res = await fetch(`/api/check?lat=${lat}&lon=${lon}`);
      const data = await res.json();
      const status = statusFromResult(data);
      if (markerRef.current) markerRef.current.setIcon(createPinIcon(L, status));
      setCard({ status, lat, lon, label, reason: data.reason, link: data.link });
    } catch {
      if (markerRef.current) markerRef.current.setIcon(createPinIcon(L, "unknown"));
      setCard({
        status: "unknown",
        lat,
        lon,
        label,
        reason: "Kon deze locatie niet controleren (databron tijdelijk niet bereikbaar).",
      });
    }
  }

  async function refreshZones() {
    const L = LRef.current;
    const map = mapRef.current;
    if (!L || !map) return;

    const zoom = map.getZoom();
    if (zoom < ZONE_MIN_ZOOM) {
      if (zonesGroupRef.current) {
        map.removeLayer(zonesGroupRef.current);
        zonesGroupRef.current = null;
      }
      setZonesHint("zoom-in");
      return;
    }
    setZonesHint("ready");

    if (zoneFetchAbortRef.current) zoneFetchAbortRef.current.abort();
    const controller = new AbortController();
    zoneFetchAbortRef.current = controller;

    const padded = clampBounds(padBounds(map.getBounds(), ZONE_PAD_FACTOR), MAX_BBOX_SPAN_DEG);
    const bbox = [padded.west, padded.south, padded.east, padded.north].join(",");

    let data;
    try {
      const res = await fetch(`/api/zones?bbox=${bbox}`, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!res.ok) return; // keep whatever's currently shown rather than blanking it on a transient/edge-case failure
      data = await res.json();
    } catch (err) {
      return; // network error or aborted (superseded by a newer request) — keep existing zones visible
    }
    if (controller.signal.aborted || !data?.features) return;

    // Build the replacement layer group fully off to the side, then swap it
    // in atomically (add new, then remove old) instead of clearing the live
    // group in place — clearing first left a blank gap during the fetch, and
    // could orphan an open hover tooltip on a layer that no longer existed.
    const nextGroup = L.layerGroup();

    // Green "allowed" wash under everything — kom polygons drawn on top
    // visually punch red through it, so unmarked ground (open countryside,
    // small settlements PDOK doesn't flag) still reads as "mag wel".
    L.rectangle(
      [
        [padded.south, padded.west],
        [padded.north, padded.east],
      ],
      { fillColor: "#22c55e", fillOpacity: 0.16, color: "#22c55e", weight: 0, interactive: false }
    ).addTo(nextGroup);

    L.geoJSON(data, {
      style: (feature) => {
        const inKom = feature.properties?.inKom;
        return inKom
          ? { fillColor: "#ef4444", fillOpacity: 0.4, color: "#b91c1c", weight: 1.5 }
          : { fillColor: "#22c55e", fillOpacity: 0.28, color: "#15803d", weight: 1.5 };
      },
      onEachFeature: (feature, layer) => {
        const { inKom, plaats } = feature.properties || {};
        const tooltipText = inKom
          ? `🔴 Bebouwde kom${plaats ? ` van ${plaats}` : ""} — wildplassen niet toegestaan`
          : `🟢 Buiten bebouwde kom${plaats ? ` (${plaats})` : ""} — wildplassen toegestaan`;
        layer.bindTooltip(tooltipText, { sticky: true, className: "zone-tooltip" });

        const baseStyle = inKom
          ? { fillColor: "#ef4444", fillOpacity: 0.4, color: "#b91c1c", weight: 1.5 }
          : { fillColor: "#22c55e", fillOpacity: 0.28, color: "#15803d", weight: 1.5 };
        const hoverStyle = { ...baseStyle, weight: 3, fillOpacity: baseStyle.fillOpacity + 0.15 };

        layer.on("mouseover", () => layer.setStyle(hoverStyle));
        layer.on("mouseout", () => layer.setStyle(baseStyle));
        layer.on("click", (e) => {
          L.DomEvent.stop(e);
          setSuggestions([]);
          checkPoint(e.latlng.lat, e.latlng.lng, plaats || null);
        });
      },
    }).addTo(nextGroup);

    if (controller.signal.aborted) return; // superseded while we were building the layer group
    nextGroup.addTo(map);
    const previousGroup = zonesGroupRef.current;
    zonesGroupRef.current = nextGroup;
    if (previousGroup) map.removeLayer(previousGroup);
  }

  function scheduleZoneRefresh() {
    if (zoneDebounceRef.current) clearTimeout(zoneDebounceRef.current);
    zoneDebounceRef.current = setTimeout(refreshZones, ZONE_DEBOUNCE_MS);
  }

  // Init map once.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const L = (await import("leaflet")).default;
      if (cancelled || !containerRef.current || mapRef.current) return;
      LRef.current = L;

      const map = L.map(containerRef.current, {
        zoomControl: false,
        attributionControl: true,
        center: [52.1, 5.3],
        zoom: 8,
      });
      L.control.zoom({ position: "bottomright" }).addTo(map);

      L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
        maxZoom: 20,
        subdomains: "abcd",
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-bijdragers &copy; <a href="https://carto.com/attributions">CARTO</a>',
      }).addTo(map);

      map.on("click", (e) => {
        setSuggestions([]);
        checkPoint(e.latlng.lat, e.latlng.lng, null);
      });
      map.on("moveend zoomend", scheduleZoneRefresh);

      mapRef.current = map;
      refreshZones();
    })();

    return () => {
      cancelled = true;
      if (zoneDebounceRef.current) clearTimeout(zoneDebounceRef.current);
      if (zoneFetchAbortRef.current) zoneFetchAbortRef.current.abort();
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function flyAndCheck(lat, lon, label) {
    if (mapRef.current) {
      mapRef.current.flyTo([lat, lon], 17, { duration: 0.8 });
    }
    checkPoint(lat, lon, label);
  }

  function onQueryChange(e) {
    const value = e.target.value;
    setQuery(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (value.trim().length < 2) {
      setSuggestions([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/suggest?q=${encodeURIComponent(value)}`);
        const data = await res.json();
        setSuggestions(data.suggestions || []);
      } catch {
        setSuggestions([]);
      }
    }, 300);
  }

  async function pickSuggestion(s) {
    setSuggestions([]);
    setQuery(s.label);
    try {
      const res = await fetch(`/api/lookup?id=${encodeURIComponent(s.id)}`);
      const data = await res.json();
      if (data.error) return;
      flyAndCheck(data.lat, data.lon, data.label);
    } catch {
      // ignore
    }
  }

  function useMyLocation() {
    if (!("geolocation" in navigator)) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        flyAndCheck(pos.coords.latitude, pos.coords.longitude, "Jouw huidige locatie");
      },
      () => setLocating(false),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  return (
    <div className="explore-wrap">
      <div ref={containerRef} className="explore-map" />

      <div className="explore-topbar">
        <Link href="/" className="round-btn" aria-label="Terug">
          ←
        </Link>
        <div className="autocomplete explore-search">
          <input
            type="text"
            placeholder="Zoek een adres of plaats…"
            value={query}
            onChange={onQueryChange}
            autoComplete="off"
          />
          {suggestions.length > 0 && (
            <ul className="suggestions">
              {suggestions.map((s) => (
                <li key={s.id} onClick={() => pickSuggestion(s)}>
                  {s.label}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <button
        type="button"
        className="round-btn locate-btn"
        onClick={useMyLocation}
        aria-label="Mijn locatie"
        disabled={locating}
      >
        {locating ? "…" : "📍"}
      </button>

      <div className="legend">
        <span className="legend-item">
          <span className="dot dot-allowed" /> mag wel
        </span>
        <span className="legend-item">
          <span className="dot dot-not-allowed" /> mag niet
        </span>
        <span className="legend-item">
          <span className="dot dot-unknown" /> geen idee
        </span>
      </div>

      {!card && zonesHint === "zoom-in" && (
        <div className="explore-hint">Zoom in om de wildplas-zones te zien</div>
      )}
      {!card && zonesHint === "ready" && (
        <div className="explore-hint">Tik op een zone voor de reden, of ergens anders op de kaart</div>
      )}

      {card && (
        <div className={`result-card status-${card.status}`}>
          <div className="result-card-head">
            <span className={`result-badge status-${card.status}`}>
              {STATUS_LABEL[card.status] || "…"}
            </span>
            {card.label && <span className="result-label">{card.label}</span>}
          </div>
          {card.status === "loading" ? (
            <p className="result-reason">Locatie checken…</p>
          ) : (
            <>
              <p className="result-reason">{card.reason}</p>
              {card.link && (
                <a className="source-link" href={card.link.url} target="_blank" rel="noreferrer">
                  {card.link.label} ↗
                </a>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

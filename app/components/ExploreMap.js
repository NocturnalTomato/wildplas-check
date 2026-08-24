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
    if (!L || !map || !zonesGroupRef.current) return;

    const zoom = map.getZoom();
    if (zoom < ZONE_MIN_ZOOM) {
      zonesGroupRef.current.clearLayers();
      setZonesHint("zoom-in");
      return;
    }
    setZonesHint("ready");

    if (zoneFetchAbortRef.current) zoneFetchAbortRef.current.abort();
    const controller = new AbortController();
    zoneFetchAbortRef.current = controller;

    const padded = padBounds(map.getBounds(), 0.3);
    const bbox = [padded.west, padded.south, padded.east, padded.north].join(",");

    try {
      const res = await fetch(`/api/zones?bbox=${bbox}`, { signal: controller.signal });
      const data = await res.json();
      if (controller.signal.aborted) return;

      zonesGroupRef.current.clearLayers();

      // Green "allowed" wash under everything — kom polygons drawn on top
      // visually punch red through it, so unmarked ground (open countryside,
      // small settlements PDOK doesn't flag) still reads as "mag wel".
      L.rectangle(
        [
          [padded.south, padded.west],
          [padded.north, padded.east],
        ],
        { fillColor: "#22c55e", fillOpacity: 0.16, color: "#22c55e", weight: 0, interactive: false }
      ).addTo(zonesGroupRef.current);

      if (!data.features) return;

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
      }).addTo(zonesGroupRef.current);
    } catch (err) {
      if (err?.name !== "AbortError") {
        // Zone shading is a progressive enhancement — silently skip on failure,
        // the click-to-check flow still works everywhere.
      }
    }
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

      zonesGroupRef.current = L.layerGroup().addTo(map);

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

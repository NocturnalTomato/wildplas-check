"use client";

import { useEffect, useRef } from "react";
import "leaflet/dist/leaflet.css";
import { createPinIcon } from "./mapIcons";

export default function LocationMap({ lat, lon }) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markerRef = useRef(null);

  // Create the map once, on mount.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const L = (await import("leaflet")).default;
      if (cancelled || !containerRef.current || mapRef.current) return;

      const map = L.map(containerRef.current, {
        zoomControl: true,
        attributionControl: true,
      }).setView([lat, lon], 17);
      map.zoomControl.setPosition("bottomright");

      // CARTO's Voyager style: a clean, colourful, modern basemap in the same
      // spirit as Google Maps. Free for reasonable hobby-project traffic; for
      // heavy traffic swap for PDOK's BRT-Achtergrondkaart WMTS instead.
      L.tileLayer("https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png", {
        maxZoom: 20,
        subdomains: "abcd",
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-bijdragers &copy; <a href="https://carto.com/attributions">CARTO</a>',
      }).addTo(map);

      markerRef.current = L.marker([lat, lon], { icon: createPinIcon(L, "select") }).addTo(map);
      mapRef.current = map;
    })();

    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-center when the coordinates change.
  useEffect(() => {
    if (mapRef.current && markerRef.current) {
      mapRef.current.setView([lat, lon], 17);
      markerRef.current.setLatLng([lat, lon]);
    }
  }, [lat, lon]);

  return <div ref={containerRef} className="map-box" />;
}

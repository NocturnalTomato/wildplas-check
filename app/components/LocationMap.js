"use client";

import { useEffect, useRef } from "react";
import "leaflet/dist/leaflet.css";

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

      // Leaflet's default marker icon path breaks under bundlers — point at the CDN instead.
      delete L.Icon.Default.prototype._getIconUrl;
      L.Icon.Default.mergeOptions({
        iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
        iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
        shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
      });

      const map = L.map(containerRef.current, {
        zoomControl: false,
        attributionControl: true,
      }).setView([lat, lon], 17);

      // OSM tiles: fine for a low-traffic hobby project. For real traffic, swap for
      // PDOK's BRT-Achtergrondkaart WMTS to stay within OSM's tile usage policy.
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "&copy; OpenStreetMap-bijdragers",
      }).addTo(map);

      markerRef.current = L.marker([lat, lon]).addTo(map);
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

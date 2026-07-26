"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";

const LocationMap = dynamic(() => import("./components/LocationMap"), { ssr: false });

export default function Home() {
  const [status, setStatus] = useState("idle"); // idle | loading | done | error
  const [result, setResult] = useState(null);

  const [address, setAddress] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [selected, setSelected] = useState(null); // { lat, lon, label }
  const debounceRef = useRef(null);

  async function runCheck(lat, lon) {
    setStatus("loading");
    try {
      const res = await fetch(`/api/check?lat=${lat}&lon=${lon}`);
      const data = await res.json();
      setResult(data);
      setStatus("done");
    } catch (e) {
      setStatus("error");
    }
  }

  function useMyLocation() {
    if (!("geolocation" in navigator)) {
      setStatus("error");
      return;
    }
    setStatus("loading");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude } = pos.coords;
        setSelected({ lat: latitude, lon: longitude, label: "Jouw huidige locatie" });
        runCheck(latitude, longitude);
      },
      () => setStatus("error"),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  function onAddressChange(e) {
    const value = e.target.value;
    setAddress(value);
    setSelected(null);
    setResult(null);
    setStatus("idle");

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
    setAddress(s.label);
    setStatus("idle");
    setResult(null);
    try {
      const res = await fetch(`/api/lookup?id=${encodeURIComponent(s.id)}`);
      const data = await res.json();
      if (data.error) {
        setStatus("error");
        return;
      }
      setSelected({ lat: data.lat, lon: data.lon, label: data.label });
    } catch {
      setStatus("error");
    }
  }

  function confirmSelected() {
    if (!selected) return;
    runCheck(selected.lat, selected.lon);
  }

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  let wrapClass = "wrap onbekend";
  if (status === "done" && result) {
    if (result.allowed === true) wrapClass = "wrap ja";
    else if (result.allowed === false) wrapClass = "wrap nee";
  }

  return (
    <main className={wrapClass}>
      <h1>MAG IK HIER WILDPLASSEN?</h1>

      {status === "done" && result && (
        <>
          <div className="answer">
            {result.allowed === true ? "JA" : result.allowed === false ? "NEE" : "GEEN IDEE"}
          </div>
          <p className="detail">{result.reason}</p>
        </>
      )}

      {status === "loading" && <p className="detail">Locatie checken…</p>}
      {status === "error" && (
        <p className="detail">Kon de locatie niet bepalen of controleren. Probeer het opnieuw.</p>
      )}

      {selected && (
        <div className="map-wrap">
          <LocationMap lat={selected.lat} lon={selected.lon} />
          <p className="map-label">📍 {selected.label}</p>
          {status !== "loading" && (
            <button onClick={confirmSelected}>
              {status === "done" ? "Check opnieuw" : "Klopt dit? Check deze locatie"}
            </button>
          )}
        </div>
      )}

      <div className="actions">
        <button onClick={useMyLocation} disabled={status === "loading"}>
          📍 Gebruik mijn locatie
        </button>
        <div className="divider">of</div>
        <div className="autocomplete">
          <input
            type="text"
            placeholder="Straat, plaats…"
            value={address}
            onChange={onAddressChange}
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

      <p className="footnote">
        Gebaseerd op de bebouwde-kom-grens (Basisregistratie Topografie). De meeste gemeentelijke APV&apos;s
        verbieden wildplassen alleen binnen de bebouwde kom — dit is een indicatie, geen juridisch advies.
      </p>
    </main>
  );
}

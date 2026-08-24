"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Image from "next/image";
import Link from "next/link";
import { parseCoordinates, parsePlusCode, parseGoogleMapsUrl, isUrl } from "../lib/parseLocationInput";

const LocationMap = dynamic(() => import("./components/LocationMap"), { ssr: false });

export default function Home() {
  const [status, setStatus] = useState("idle"); // idle | loading | done | error
  const [result, setResult] = useState(null);

  const [showAddressForm, setShowAddressForm] = useState(false);
  const [address, setAddress] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [selected, setSelected] = useState(null); // { lat, lon, label }
  const debounceRef = useRef(null);
  const addressInputRef = useRef(null);
  const [focusTick, setFocusTick] = useState(0);

  useEffect(() => {
    if (showAddressForm) {
      addressInputRef.current?.focus();
    }
  }, [showAddressForm, focusTick]);

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

  // Enter in the address bar should go straight to a result — no extra
  // "Klopt dit?" click. Accepts a plain address, "lat, lon" pairs, a Google
  // Plus Code, or a Google Maps URL (including shortened links).
  async function onAddressKeyDown(e) {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const raw = address.trim();
    if (!raw) return;

    const coords = parseCoordinates(raw);
    if (coords) {
      setSuggestions([]);
      setSelected({ lat: coords.lat, lon: coords.lon, label: raw });
      runCheck(coords.lat, coords.lon);
      return;
    }

    const plusCode = parsePlusCode(raw);
    if (plusCode) {
      setSuggestions([]);
      setSelected({ lat: plusCode.lat, lon: plusCode.lon, label: raw });
      runCheck(plusCode.lat, plusCode.lon);
      return;
    }

    if (isUrl(raw)) {
      const fromUrl = parseGoogleMapsUrl(raw);
      if (fromUrl) {
        setSuggestions([]);
        setSelected({ lat: fromUrl.lat, lon: fromUrl.lon, label: raw });
        runCheck(fromUrl.lat, fromUrl.lon);
        return;
      }
      setSuggestions([]);
      setStatus("loading");
      setResult(null);
      try {
        const res = await fetch(`/api/resolve-url?q=${encodeURIComponent(raw)}`);
        const data = await res.json();
        if (data.error) {
          setStatus("error");
          return;
        }
        setSelected({ lat: data.lat, lon: data.lon, label: raw });
        runCheck(data.lat, data.lon);
      } catch {
        setStatus("error");
      }
      return;
    }

    let list = suggestions;
    if (list.length === 0) {
      try {
        const res = await fetch(`/api/suggest?q=${encodeURIComponent(raw)}`);
        const data = await res.json();
        list = data.suggestions || [];
      } catch {
        list = [];
      }
    }
    if (list.length === 0) {
      setStatus("error");
      return;
    }
    await pickSuggestionAndCheck(list[0]);
  }

  async function pickSuggestionAndCheck(s) {
    setSuggestions([]);
    setAddress(s.label);
    setStatus("loading");
    setResult(null);
    try {
      const res = await fetch(`/api/lookup?id=${encodeURIComponent(s.id)}`);
      const data = await res.json();
      if (data.error) {
        setStatus("error");
        return;
      }
      setSelected({ lat: data.lat, lon: data.lon, label: data.label });
      runCheck(data.lat, data.lon);
    } catch {
      setStatus("error");
    }
  }

  function reset() {
    setStatus("idle");
    setResult(null);
    setSelected(null);
    setAddress("");
    setSuggestions([]);
    setShowAddressForm(true);
    setFocusTick((t) => t + 1);
  }

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const answerClass =
    status === "done" && result
      ? result.allowed === true
        ? "answer ja"
        : result.allowed === false
        ? "answer nee"
        : "answer onbekend"
      : "";

  return (
    <main className="wrap">
      <div className="bg-photo">
        <Image src="/hero.jpg" alt="" fill priority sizes="100vw" style={{ objectFit: "cover" }} />
      </div>
      <div className="bg-overlay" />

      <div className="content">
        <h1>MAG IK HIER WILDPLASSEN?</h1>

        {status === "idle" && !selected && (
          <>
            <p className="subtext">Eén druk op de knop en we checken je locatie.</p>
            <button className="cta" onClick={useMyLocation}>
              📍 CHECK MIJN LOCATIE
            </button>
            <button
              type="button"
              className="link-btn"
              onClick={() => setShowAddressForm((v) => !v)}
            >
              of voer een adres in
            </button>
          </>
        )}

        {status === "loading" && <p className="subtext">Locatie checken…</p>}

        {status === "error" && (
          <>
            <p className="subtext">Kon de locatie niet bepalen of controleren.</p>
            <button className="cta" onClick={useMyLocation}>
              📍 PROBEER OPNIEUW
            </button>
          </>
        )}

        {status === "done" && result && (
          <>
            <div className={answerClass}>
              {result.allowed === true ? "JA" : result.allowed === false ? "NEE" : "GEEN IDEE"}
            </div>
            <p className="subtext">{result.reason}</p>
            {result.link && (
              <a className="source-link" href={result.link.url} target="_blank" rel="noreferrer">
                {result.link.label} ↗
              </a>
            )}
            <button className="cta cta-secondary" onClick={reset}>
              Check een andere plek
            </button>
          </>
        )}

        {(showAddressForm || (selected && status !== "done")) && (
          <div className="address-panel">
            <div className="autocomplete">
              <input
                ref={addressInputRef}
                type="text"
                placeholder="Straat, plaats, coördinaten of Google-maps link…"
                value={address}
                onChange={onAddressChange}
                onKeyDown={onAddressKeyDown}
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

            {selected && (
              <div className="map-wrap">
                <LocationMap lat={selected.lat} lon={selected.lon} />
                <p className="map-label">📍 {selected.label}</p>
                <button className="cta" onClick={confirmSelected}>
                  Klopt dit? Check deze locatie
                </button>
              </div>
            )}
          </div>
        )}

        <p className="footnote">
          Gebaseerd op de bebouwde-kom-grens (Basisregistratie Topografie). De meeste gemeentelijke APV&apos;s
          verbieden wildplassen alleen binnen de bebouwde kom — dit is een indicatie, geen juridisch advies.
        </p>
      </div>

      <Link href="/kaart" className="map-fab">
        🗺️ Verken de kaart
      </Link>
    </main>
  );
}

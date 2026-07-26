"use client";

import { useState } from "react";

export default function Home() {
  const [status, setStatus] = useState("idle"); // idle | loading | done | error
  const [result, setResult] = useState(null);
  const [address, setAddress] = useState("");

  async function checkLatLon(lat, lon) {
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
      (pos) => checkLatLon(pos.coords.latitude, pos.coords.longitude),
      () => setStatus("error"),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }

  async function checkAddress(e) {
    e.preventDefault();
    if (!address.trim()) return;
    setStatus("loading");
    try {
      const res = await fetch(`/api/check?address=${encodeURIComponent(address)}`);
      const data = await res.json();
      setResult(data);
      setStatus("done");
    } catch (e) {
      setStatus("error");
    }
  }

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
        <p className="detail">Kon je locatie niet bepalen. Probeer het opnieuw of typ een adres in.</p>
      )}

      <div className="actions">
        <button onClick={useMyLocation} disabled={status === "loading"}>
          📍 Gebruik mijn locatie
        </button>
        <div className="divider">of</div>
        <form onSubmit={checkAddress} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <input
            type="text"
            placeholder="Straat, plaats…"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
          <button type="submit" disabled={status === "loading"}>
            Check adres
          </button>
        </form>
      </div>

      <p className="footnote">
        Gebaseerd op de bebouwde-kom-grens (Basisregistratie Topografie). De meeste gemeentelijke APV&apos;s
        verbieden wildplassen alleen binnen de bebouwde kom — dit is een indicatie, geen juridisch advies.
      </p>
    </main>
  );
}

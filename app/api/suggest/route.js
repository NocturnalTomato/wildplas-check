import { NextResponse } from "next/server";

// PDOK Locatieserver — free-text suggest (autocomplete), no API key required.
const SUGGEST_URL = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/suggest";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q");

  if (!q || q.trim().length < 2) {
    return NextResponse.json({ suggestions: [] });
  }

  try {
    const url = `${SUGGEST_URL}?q=${encodeURIComponent(q)}&rows=6&fq=type:(adres OR woonplaats OR weg)`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("suggest_failed");
    const data = await res.json();
    const docs = data?.response?.docs || [];
    const suggestions = docs.map((d) => ({ id: d.id, label: d.weergavenaam }));
    return NextResponse.json({ suggestions });
  } catch (err) {
    return NextResponse.json({ suggestions: [], error: String(err.message || err) });
  }
}

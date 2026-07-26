import { NextResponse } from "next/server";

// PDOK Locatieserver — resolves a suggest() id to full details incl. coordinates.
const LOOKUP_URL = "https://api.pdok.nl/bzk/locatieserver/search/v3_1/lookup";

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "missing id" }, { status: 400 });
  }

  try {
    const url = `${LOOKUP_URL}?id=${encodeURIComponent(id)}&fl=weergavenaam,centroide_ll`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("lookup_failed");
    const data = await res.json();
    const doc = data?.response?.docs?.[0];
    if (!doc?.centroide_ll) throw new Error("no_result");
    // centroide_ll looks like "POINT(4.897070 52.377956)" (lon lat)
    const match = /POINT\(([-\d.]+)\s+([-\d.]+)\)/.exec(doc.centroide_ll);
    if (!match) throw new Error("bad_geometry");
    return NextResponse.json({
      lat: parseFloat(match[2]),
      lon: parseFloat(match[1]),
      label: doc.weergavenaam,
    });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 502 });
  }
}

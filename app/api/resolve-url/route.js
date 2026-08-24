import { NextResponse } from "next/server";

// Resolves a (possibly shortened, e.g. maps.app.goo.gl) Google Maps URL to
// coordinates by following redirects server-side — the browser can't read the
// final redirected URL of a cross-origin request itself.
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const raw = (searchParams.get("q") || "").trim();

  if (!/^https?:\/\//i.test(raw)) {
    return NextResponse.json({ error: "not_a_url" }, { status: 400 });
  }

  try {
    const res = await fetch(raw, { redirect: "follow" });
    let text = res.url || raw;
    try {
      text += " " + (await res.text()).slice(0, 2000);
    } catch {}

    const atMatch = text.match(/@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
    if (atMatch) {
      return NextResponse.json({ lat: parseFloat(atMatch[1]), lon: parseFloat(atMatch[2]) });
    }
    const llMatch = text.match(/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/);
    if (llMatch) {
      return NextResponse.json({ lat: parseFloat(llMatch[1]), lon: parseFloat(llMatch[2]) });
    }
    const qMatch = text.match(/[?&]q=(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
    if (qMatch) {
      return NextResponse.json({ lat: parseFloat(qMatch[1]), lon: parseFloat(qMatch[2]) });
    }
    return NextResponse.json({ error: "no_coords_found" }, { status: 404 });
  } catch (err) {
    return NextResponse.json({ error: String(err.message || err) }, { status: 502 });
  }
}

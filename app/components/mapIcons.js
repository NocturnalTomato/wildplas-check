// Shared Leaflet pin icons — a flat, Google-Maps-style teardrop rendered as
// inline SVG in a divIcon, so we don't need separate marker image assets per
// color/state.

const COLORS = {
  select: "#4f46e5", // neutral "this is the point you picked" pin
  allowed: "#22c55e", // JA
  "not-allowed": "#ef4444", // NEE
  unknown: "#9ca3af", // GEEN IDEE
  loading: "#3b82f6", // checking…
};

// `L` must be the already-loaded leaflet module (callers load it via
// `await import("leaflet")` first, since leaflet touches `window` on load
// and this file must stay safe to import from server-rendered code).
export function createPinIcon(L, status = "select", { pulse = false } = {}) {
  const color = COLORS[status] || COLORS.select;

  const html = `
    <div class="pin-wrap${pulse ? " pin-pulse" : ""}">
      <svg width="34" height="46" viewBox="0 0 34 46" xmlns="http://www.w3.org/2000/svg">
        <path d="M17 0C7.6 0 0 7.6 0 17c0 12 17 29 17 29s17-17 17-29C34 7.6 26.4 0 17 0z" fill="${color}" stroke="#fff" stroke-width="2"/>
        <circle cx="17" cy="17" r="6.5" fill="#fff"/>
      </svg>
    </div>
  `;

  return L.divIcon({
    html,
    className: "pin-icon",
    iconSize: [34, 46],
    iconAnchor: [17, 46],
    popupAnchor: [0, -40],
  });
}

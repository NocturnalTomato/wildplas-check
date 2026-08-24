// Sends a heads-up email when apv-watch finds a wildplassen-bepaling that
// deviates from the standard VNG scope and needs a human read (see
// app/api/cron/apv-watch/route.js). Uses Resend's plain HTTP API — no SDK
// dependency, just fetch — since that's all a one-email-a-day alert needs.
//
// Requires env vars (set in Vercel project settings, not committed):
//   RESEND_API_KEY   — from resend.com
//   ALERT_EMAIL_TO   — where the alert should land
//   ALERT_EMAIL_FROM — optional, defaults to Resend's sandbox sender (only
//                      deliverable to the Resend account owner's own address
//                      until you verify a sending domain)
const RESEND_API_URL = "https://api.resend.com/emails";
const DEFAULT_FROM = "APV Watch <onboarding@resend.dev>";

function findingsToHtml(findings) {
  const items = findings
    .map((f) => {
      const matches = f.matches
        .map((m) => `${m.keyword}${m.article ? ` (${m.article})` : ""}: <em>${m.snippet}</em>`)
        .join("<br>");
      return `<li><strong>${f.gemeente}</strong> — <a href="${f.apv_url}">bekijk de APV</a><br>${matches}</li>`;
    })
    .join("\n");

  return `<p>De dagelijkse APV-watch cron vond ${findings.length} gemeente(s) met een wildplassen-bepaling die afwijkt van de standaard VNG-scope ("verboden binnen de bebouwde kom"). Deze vragen om een menselijke check voordat (en of) <code>lib/exceptions.json</code> wordt bijgewerkt.</p><ul>${items}</ul>`;
}

export async function sendFindingsAlert(findings) {
  if (!findings || findings.length === 0) return { sent: false, reason: "no_findings" };

  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.ALERT_EMAIL_TO;
  if (!apiKey || !to) return { sent: false, reason: "not_configured" };

  const from = process.env.ALERT_EMAIL_FROM || DEFAULT_FROM;
  const subject = `APV-watch: ${findings.length} gemeente(s) vragen om review`;

  try {
    const res = await fetch(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to, subject, html: findingsToHtml(findings) }),
    });
    if (!res.ok) {
      console.error("apv_watch_alert_failed", res.status, await res.text());
      return { sent: false, reason: `resend_${res.status}` };
    }
    return { sent: true };
  } catch (err) {
    console.error("apv_watch_alert_failed", err);
    return { sent: false, reason: String(err.message || err) };
  }
}

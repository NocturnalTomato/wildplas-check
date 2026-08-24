# wildplas-check

**MAG IK HIER WILDPLASSEN?** — een locatie-gebaseerde check.

## De juridische kern (onderzoek)

Er is geen landelijk wettelijk verbod op wildplassen. Elke gemeente regelt het zelf via de
Algemene Plaatselijke Verordening (APV). Vrijwel alle gemeenten gebruiken hiervoor dezelfde
VNG-modeltekst, die het verbiedt **binnen de bebouwde kom** en er buiten de bebouwde kom
niets over zegt (= toegestaan, behalve losse uitzonderingen — zie hieronder).

Dat betekent: dit is niet een "zoek 342 gemeente-APV's uit"-probleem, maar een
"waar ligt de bebouwde-kom-grens op dit punt"-probleem — en dát is nationaal als open
geodata beschikbaar.

**Databron:** Kadaster/BRT (Basisregistratie Topografie) — TOP10NL, laag "Plaatsen (vlakken)",
met booleaans attribuut `BEBOUWDEKOM`. Vrij beschikbaar via PDOK WFS
(`https://service.pdok.nl/brt/top10nl/wfs/v1_0`). Dit is de bron in de zin van de
Wegenverkeerswet (blauwe komborden) — er bestaan ook andere "bebouwde kom"-definities
(bestemmingsplan, natuurwetgeving), maar deze sluit het beste aan bij hoe APV's het
begrip meestal hanteren.

**Bekende uitzondering:** een klein aantal gemeenten breidt het verbod uit naar met naam
genoemde gebieden buiten de bebouwde kom (bv. het Haagse Bos in Den Haag). Deze staan in
`lib/exceptions.json` — uit te breiden naarmate je meer APV's natrekt via
[lokaleregelgeving.overheid.nl](https://lokaleregelgeving.overheid.nl).

⚠️ Dit is een indicatie voor de lol, geen juridisch advies.

## Architectuur

```
Browser (geolocation of adres)
   │
   ▼
Next.js app (Vercel)
   │
   ├─ /api/check
   │    ├─ adres? → PDOK Locatieserver (gratis geocoding)
   │    └─ lat/lon → PDOK TOP10NL WFS point-in-polygon (BEBOUWDEKOM attribuut)
   │         └─ exceptions.json override (named areas)
   │
   ▼
JA / NEE + uitleg
```

Geen eigen database nodig — alle geodata wordt live bevraagd bij PDOK. `exceptions.json`
is de enige plek die handmatig onderzoek vereist en kan groeien naarmate je meer
gemeenten natrekt.

## Dagelijkse APV-check (cron)

`app/api/cron/apv-watch/route.js` draait dagelijks via Vercel Cron (`vercel.json`,
05:00 UTC) en helpt `lib/exceptions.json` actueel te houden:

1. Vraagt bij KOOP's CVDR-zoekdienst (`zoekservice.overheid.nl/sru`) op welke
   gemeente-APV's de laatste dagen zijn gewijzigd.
2. Haalt van elke recent gewijzigde APV de volledige tekst op en zoekt naar
   wildplassen-gerelateerde bepalingen ("wildplassen", "natuurlijke behoefte
   doen", "urineren").
3. Filtert gevonden bepalingen die simpelweg de standaard VNG-scope bevestigen
   (verboden **binnen de bebouwde kom**) eruit — dat is al de aanname van dit
   hele project, dus geen actie nodig. Alleen bepalingen die daarvan afwijken
   (geen "bebouwde kom" in de buurt van de match — bv. een met naam genoemd
   gebied zoals het Haagse Bos) worden als `findings` gerapporteerd, mét link
   naar het CVDR-document.
4. De job **bewerkt `exceptions.json` niet automatisch** — een gevonden
   afwijkende bepaling vraagt om een menselijke lezing (wat staat er *precies*,
   geldt het echt buiten de bebouwde kom, etc.). Bekijk de Vercel-cronlogs
   (`APV_WATCH_FINDING`) en werk `exceptions.json` handmatig bij.

Zet in de Vercel-projectinstellingen een env var `CRON_SECRET` (willekeurige
string) — Vercel stuurt die automatisch mee als bearer-token bij cron-aanroepen
en de route weigert verzoeken zonder de juiste token.

## TODO / bekende risico's

- Uitbreiden van `lib/exceptions.json` met meer gemeenten op basis van de
  `apv-watch`-cron findings.
- Eventueel cachen van PDOK-responses (Vercel Edge Cache / KV) als verkeer toeneemt.

## Development

```bash
npm install
npm run dev
```

## Deploy

Verbonden met Vercel via Git — elke push naar `main` deployt automatisch.

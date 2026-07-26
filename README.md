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

## TODO / bekende risico's

- **Verifieer `TOP10NL_TYPENAME`** in `app/api/check/route.js` tegen een actuele
  `DescribeFeatureType` call — PDOK-laagnamen wijzigen af en toe tussen TOP10NL-releases.
- Uitbreiden van `lib/exceptions.json` met meer gemeenten na verder onderzoek.
- Eventueel cachen van WFS-responses (Vercel Edge Cache / KV) als verkeer toeneemt.

## Development

```bash
npm install
npm run dev
```

## Deploy

Verbonden met Vercel via Git — elke push naar `main` deployt automatisch.

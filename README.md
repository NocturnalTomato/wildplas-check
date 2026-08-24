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

**Bekende uitzonderingen:** een aantal gemeenten breidt het verbod uit naar gebieden buiten
de bebouwde kom — soms een met naam genoemd gebied, soms een kleiner, door het college
aangewezen gebied binnen een verder heel gewone APV-tekst. Deze staan in
`lib/exceptions.json` (leeg totdat er weer een geverifieerde uitzondering in staat — zie
`_comment` in dat bestand voor de laatst verwijderde entry en waarom) — uit te breiden
naarmate je meer APV's natrekt via
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

## Directe APV-links (`lib/apvLookup.js`)

Zowel `/api/check` als de kaart linken niet naar een generieke zoekpagina, maar naar het
daadwerkelijke, actueel geldende APV-document van de gemeente — en waar mogelijk direct
naar het artikel over wildplassen/natuurlijke behoefte. `findWildplasApvLink(gemeente)`:

1. Zoekt via dezelfde CVDR SRU-zoekdienst als de cron (`zoekservice.overheid.nl/sru`)
   naar de APV-records van die gemeente, en kiest het record dat nu geldig is (heeft een
   `inwerkingtredingDatum`, geen `uitwerkingtredingDatum`).
2. Doorzoekt de volledige XML-tekst van dat document op "wildplassen" / "natuurlijke
   behoefte" / "urineren" en bepaalt het dichtstbijzijnde artikelnummer.
3. Zoekt op de CVDR HTML-pagina naar het anchor-id van dat artikel, zodat de link direct
   naar het artikel scrollt (`...#hoofdstuk_..._artikel_...`) in plaats van naar de bovenkant
   van het document.

Als een van deze stappen niets oplevert (gemeente niet gevonden op CVDR, geen match in de
tekst, geen anchor gevonden), valt de route netjes terug op een bredere link (documentniveau,
of — als er helemaal niets is — de generieke zoekpagina/politie.nl). Resultaten worden
24 uur in-memory gecached per gemeente om herhaalde SRU/XML/HTML-round-trips te vermijden.

## Kaart (`/kaart`)

Een volledig interactieve, Google Maps-achtige kaart (CARTO Voyager-tiles) met:

- **Zone-arcering**: vanaf een bepaald zoomniveau worden de bebouwde-kom-polygonen
  (`/api/zones`, dezelfde PDOK TOP10NL-bron als `/api/check`) rood gearceerd getekend
  (niet toegestaan), met een groene wash eronder voor de rest (toegestaan).
- **Hover**: een tooltip op een zone toont meteen wat er geldt, zonder klikken.
- **Klikken** (op een zone of waar dan ook op de kaart) checkt dat exacte punt via
  `/api/check` en toont een kaartje met de reden en de directe APV-link (zie hierboven).
- Adres-zoekbalk (PDOK-suggest) en een "mijn locatie"-knop, net als op de homepage.

## Dagelijkse APV-check (cron)

`app/api/cron/apv-watch/route.js` draait dagelijks via Vercel Cron (`vercel.json`,
05:00 UTC) en helpt `lib/exceptions.json` actueel te houden:

1. Vraagt bij KOOP's CVDR-zoekdienst (`zoekservice.overheid.nl/sru`) op welke
   gemeente-APV's de laatste dagen zijn gewijzigd.
2. Haalt van elke recent gewijzigde APV de volledige tekst op en zoekt naar
   wildplassen-gerelateerde bepalingen ("wildplassen", "natuurlijke behoefte
   doen", "urineren").
3. Filtert gevonden bepalingen die simpelweg de standaard VNG-scope bevestigen
   (verboden **binnen de bebouwde kom**, en verder niets) eruit — dat is al de
   aanname van dit hele project, dus geen actie nodig. Een bepaling wordt als
   afwijkend gezien (en als `finding` gerapporteerd) in twee gevallen: (a) het
   hele wetsartikel noemt "bebouwde kom" nergens (bv. een met naam genoemd
   gebied), of (b) het artikel noemt "bebouwde kom" wél, maar breidt het
   verbod ook uit naar een door het college/de burgemeester aangewezen gebied
   *buiten* de bebouwde kom — dat mist een simpele "staat 'bebouwde kom' in de
   buurt?"-check omdat de bebouwde kom ook gewoon genoemd wordt (zie
   Bodegraven-Reeuwijk artikel 4:8 als schoolvoorbeeld). Elke finding komt met
   het dichtstbijzijnde artikelnummer (bv. "Artikel 4:8") en link naar het
   CVDR-document.
4. De job **bewerkt `exceptions.json` niet automatisch** — een gevonden
   afwijkende bepaling vraagt om een menselijke lezing (wat staat er *precies*,
   geldt het echt buiten de bebouwde kom, etc.). Bekijk de Vercel-cronlogs
   (`APV_WATCH_FINDING`) en werk `exceptions.json` handmatig bij.
5. Bij één of meer findings stuurt de job ook een e-mail (via `lib/notify.js`,
   Resend's HTTP API — geen extra dependency) zodat je niet zelf de cronlogs
   hoeft te checken. Zonder findings wordt er niets gestuurd.

Zet in de Vercel-projectinstellingen een env var `CRON_SECRET` (willekeurige
string) — Vercel stuurt die automatisch mee als bearer-token bij cron-aanroepen
en de route weigert verzoeken zonder de juiste token.

Voor de e-mailalert zijn twee extra env vars nodig (zonder deze logt de job de
findings gewoon, maar verstuurt niets):

- `RESEND_API_KEY` — API-key van [resend.com](https://resend.com) (gratis tier
  volstaat voor één e-mail per dag).
- `ALERT_EMAIL_TO` — het adres dat de melding moet ontvangen.
- `ALERT_EMAIL_FROM` — optioneel; standaard Resend's sandbox-afzender
  (`onboarding@resend.dev`), die alleen aankomt bij het eigen
  Resend-accountadres. Verifieer een eigen domein bij Resend en zet dit env
  var om vanaf een eigen adres te versturen.

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

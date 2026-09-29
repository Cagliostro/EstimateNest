# Architektur: EstimateNest

> **Hinweis Backfill:** Rekonstruiert aus dem vorhandenen Code
> (`~/WebstormProjects/EstimateNest`) und dessen CLAUDE.md. ADRs sind
> retrospektiv als „Entscheidung + Begründung" festgehalten. Umsetzung ist
> bereits abgeschlossen und live (dev + prod).

- datum: 2026-09-04
- aktualisiert: 2026-09-29 (Runde 1 „betriebs-haertung" — §10)
- basis: requirements.md

## 1. Kontext & Ziele

Planning-Poker-Web-App für agile Teams ohne Registrierung: Raum teilen
(6-stelliger Code), Echtzeit-Voting, Moderator-Steuerung, 14-Tage-Ephemerität.
Wichtigste Treiber: **Zero sign-up** (kein Konto-Zwang), **geringe laufende
Kosten** (serverless), **niedrige Wartung** (keine Server), schnelle
Iteration über automatisierte Deploys. Bewusst kein Auth-System, keine
dauerhafte Personen-Speicherung.

## 2. Tech-Stack

| Ebene | Entscheidung | Begründung |
|---|---|---|
| Frontend | React 18 + Vite 5 + TypeScript + Tailwind | etablierter Stack; Vite für schnelle Builds |
| Frontend-State | Zustand (Store je Domäne) | schlank, ohne Boilerplate; Stores: room/participant/connection |
| Echtzeit-Client | Eigener WebSocketService (Singleton) + useRoomConnection-Hook | Singleton verhindert Mehrfach-Instanzen/Handler-Leaks bei Strict-Mode |
| Backend | AWS Lambda (Node 24, TypeScript, tsup-CJS-Bundle) | serverless, kostenoptimiert; kein Server-Betrieb |
| API | API Gateway: REST (Bootstrap) + WebSocket (Echtzeit) | REST nur `POST /rooms`, `GET /rooms/{code}`, Update/History; Zustand via WS-Broadcasts |
| Persistenz | DynamoDB (6 Tabellen, PAY_PER_REQUEST, TTL) | serverless KV; TTL für 14-Tage-Raumablauf |
| Infrastruktur | AWS CDK v2 (TypeScript) | Infrastruktur als Code, zwei Umgebungen (dev/prod) |
| Hosting Frontend | S3 + CloudFront + Route 53 (Custom Domain) | statisch, CDN, kostengünstig |
| CI/CD | GitHub Actions (push development→dev, push main→prod) | automatischer Deploy; PRs nur Test-Job |
| Validierung | Zod v4 (Schemas in packages/shared) | eine Quelle der Wahrheit für WS-/REST-Payloads |
| Testen | Vitest (Backend 112, Frontend 32), Playwright (e2e, dev-smoke) | Unit-/Integration + echte Browser-Szenarien |
| Code-Qualität | ESLint 10 (flat config) + Prettier | inkl. React-Compiler-Regeln (eslint-plugin-react-hooks v7) |

## 3. Projektstruktur (npm-Workspaces-Monorepo)

```
EstimateNest/
  frontend/                  # React 18 + Vite + Tailwind + Zustand
    src/
      pages/                 # HomePage (Landing+Join), RoomPage, LegalPage, NotFoundPage
      components/            # Avatar, CountdownOverlay, DeckCards, ...
      store/                 # room-store, participant-store, connection-store (Zustand)
      hooks/use-room-connection.ts  # einziger WebSocket-Owner: reconnect, Polling-Fallback
      lib/                   # websocket-service (Singleton), api-client, config, room-identity
      content/landing.ts     # Landing-Kopien (Hero, Features, FAQ)
  backend/                   # AWS-Lambda-Handler (Node 24)
    src/handlers/            # create-room, join-room, health, update-room, round-history,
                             # websocket-connect/disconnect, vote, scheduled-auto-reveal
    src/utils/               # broadcast (Fan-out), cache, dynamodb, logger (PII-redacted), password
    src/local-server.ts      # Express+ws-In-Memory-Mock für lokale Entwicklung (spiegelt Prod-Verhalten)
  infrastructure/            # AWS-CDK-Stack (estimateneest-stack.ts), cdk.json je env
  e2e/                       # Playwright (smoke, scenarios, seo, dev-smoke)
  packages/shared/           # gemeinsame Typen, Zod-Schemas, Deck-/Short-Code-Utils
```

## 4. Datenfluss (Bootstrap + Echtzeit)

1. **REST-Bootstrap:** `POST /rooms` → Raum + Kurzcode; `GET /rooms/{code}` →
   Join. Antwort trägt roomId, participantId und WS-URL.
2. **WebSocket** `wss://…?roomId=…&participantId=…`: Client-Nachrichten
   `join, vote, reveal, newRound, updateRound, updateParticipant, leave`;
   Server-Broadcasts `participantList, roundUpdate, autoRevealCountdown, error, ack`.
3. Der Client pollt bei WS-Verlust per REST-Join (5 s, Backoff bis 30 s) und
   reconnectet selbst — UI-Zustand bleibt synchron.
4. `local-server.ts` spiegelt die Prod-Nachrichtenmechanik in-memory (ohne
   AWS) für Tests und lokale Entwicklung; E2E laufen gegen ihn, nur
   `test:dev-smoke` gegen echtes AWS.

## 5. DynamoDB-Tabellen

| Tabelle | Key | Zweck |
|---|---|---|
| RoomsTable | id, sk | Raum-Metadaten |
| RoomCodesTable | shortCode | Code → Raum-Lookup |
| ParticipantsTable | roomId, participantId (+GSI ConnectionIdIndex) | Anwesenheit, Verbindungen, Moderator |
| RoundsTable | roomId, roundId (+GSI RoomIdStartedAtIndex) | Runden inkl. ACTIVE-Marker |
| VotesTable | roundId, participantId (+GSI RoomIdIndex) | Stimmen |
| RateLimitTable | key, timestamp | WS-Rate-Limit |

Alle PAY_PER_REQUEST; TTL-Attribut `expiresAt` in **Epoch-Sekunden** (ISO-String
würde Ablauf stillschweigend deaktivieren — dokumentierter Produktions-Bug).

## 6. Architektur-Entscheidungen (ADR)

### ADR-1: Serverless statt eigener Server
**Entscheidung:** Lambda + API Gateway + DynamoDB statt Node-Server/EC2/Container.
**Begründung:** Keine Betriebspflicht, Kosten nur bei Nutzung, automatische
Skalierung für burstartige Meeting-Spitzen. Nachteil (Lambda-Kaltstarts) wird
durch schlanke Handler akzeptiert.

### ADR-2: REST nur Bootstrap, Echtzeit komplett über WebSocket
**Entscheidung:** Alle Zustandsänderungen laufen als WS-Nachrichten; REST
erzeugt/joind Räume nur.
**Begründung:** Ein Pfad für den Echtzeit-Zustand (Broadcast-Fan-out) statt
dualer REST/WS-Synchronisation; Client-Stores werden ausschließlich von
Broadcasts gespeist (Polling nur als Fallback).

### ADR-3: Ephemere Räume mit TTL statt Accounts
**Entscheidung:** Keine Nutzerkonten; Räume laufen nach 14 Tagen ab
(DynamoDB-TTL), Identität nur in sessionStorage des Browsers.
**Begründung:** Zero-sign-up-Kernversprechen, minimale Datenhaltung
(DSGVO-freundlich), keine Auth-Infrastruktur.

### ADR-4: tsup-CJS-Bundle mit eingebettetem @estimatenest/shared
**Entscheidung:** Handler werden als einzelne CJS-Dateien gebundelt; shared
wird in die Lambda-Artefakte eingebettet (kein externer node_modules-Zugriff).
**Begründung:** Lambda-Deploy mit vollständigem Artefakt; die Build-Reihenfolge
shared → backend ist load-bearing (NodejsFunction zeigt auf
`backend/dist/handlers/*.js`).

### ADR-5: Moderator-Modell ohne Rollen-Serverlogik-Vielfalt
**Entscheidung:** Erster Teilnehmer = Moderator; verliert er die Verbindung,
wird nach 60-s-Grace der älteste anwesende Teilnehmer transaktional befördert
(Commit-Zeit-Conditions gegen Wettläufe); Reconnect behält die Rolle.
**Begründung:** Kein expliziter Rollen-Transfer nötig für die übliche
Nutzung (Meeting-Gastgeber bleibt), trotzdem kein Vakuum bei Abwesenheit.
Passwortgeschützte Räume: Erstbeiter-Claim erst nach Passwort-Verifikation
(seit 2026-09-04, Commits b0dbf25 + 37c4510); der Ersteller tritt beim
Erstellen mit dem Passwort automatisch bei. Seit 2026-09-04 (Commit
26809e5, BK-011) markiert auch der Solo-Leave des Moderators eine Vacancy —
der nächste Beitritt/Connect löst nach der Grace die Promotion aus.

### ADR-6: Robuste Konsistenz bei Broadcast/Store
**Entscheidung:** Transaktionales Entfernen von Teilnehmern (connectionCount
an Removal gebunden), Reveal-Guard gegen veraltete Snapshot-Überschreibungen,
Vote-Transaktionen mit Konflikt-Retry (5 Versuche, Backoff), Room-Guard im
Frontend (keine Cross-Room-State-Leaks), Handler-Registrierung idempotent.
**Begründung:** Diese Stellen waren reale Produktions-Incidents
(Geister-Teilnehmer, Doppel-Joins, Moderator-Vakuum, stale Reveals) — Fixes
sind als Regressions-Tests abgesichert.

### ADR-7: Frontend-Recency ohne Effekt-Resets
**Entscheidung:** Runden-spezifischer UI-Zustand (Kartenauswahl) wird an die
Round-Id gekoppelt und während des Renderings abgeleitet statt per
useEffect-Reset zurückgesetzt.
**Begründung:** React-Compiler-Regeln (eslint-plugin-react-hooks v7): kein
set-state-in-effect; stabile Hook-Werte via Lazy-`useState` statt Refs.

### ADR-8: SEO durch Prerender statt SSR-Framework
**Entscheidung:** Landing-Page wird beim Build als statisches HTML in
`dist/index.html` injiziert (scripts/prerender-home.mts); dev liefert
`noindex,nofollow`, prod `index,follow`; Sitemap nur für `/` und `/legal`.
**Begründung:** SPA bleibt einfach; nur die öffentlichen Seiten brauchen
Crawlability. Room-Seiten sind bewusst nicht indexierbar.

### ADR-9: Blue/Green entfernt, einfacher CDK-Deploy
**Entscheidung:** Ursprüngliches Blue/Green mit Traffic-Switch wurde entfernt;
Deploy = CDK-Update + S3-Sync + CloudFront-Invalidierung; WAF-WebACLs entfernt.
**Begründung:** Bei Ephemerität und kleinem Team überwiegen Einfachheit und
Kostenersparnis; Risiko-Rollback über CloudFront/Route-53 bleibt möglich.

## 7. Kosten-Schätzung (€/Monat)

Serverless, PAY_PER_REQUEST, keine festen Instanzen, kein WAF:

| Position | Annahme | €/Monat |
|---|---|---|
| Lambda (REST+WS+Scheduled) | geringe Meeting-Nutzung, ~1 Mio. Invocations | ~1–2 € |
| API Gateway (REST+WS) | inkl. WS-Nachrichten, geringes Volumen | ~1–2 € |
| DynamoDB (6 Tabellen, On-Demand) | wenige GB-Monate, minimale RCU/WCU | ~1–3 € |
| CloudFront + S3 | statisches Frontend, kleines Volumen | ~0,50–1 € |
| Route 53 + ACM | 2 Domains (dev/prod), Zertifikate kostenlos | ~0,50 € |
| **Summe** | realistische Basis-Nutzung | **~5–10 €/Monat** |

Kosten-Nachweis aus dem Code: PAY_PER_REQUEST in CDK, TTL begrenzt
Datenbestand, WAF entfernt (Commits `2b66bb8`, `f3431dd`), Scheduled-Lambda
nur bei Auto-Reveal aktiv.

### Ist-Validierung (BK-009, 2026-09-04)

`aws ce get-cost-and-usage` (Account 851725560801, monthly, nach Service,
UnblendedCost, inkl. Tax; Gruppen > 0,01 USD):

| Monat | Summe inkl. Tax | Davon netto (o. Tax) | Größte Positionen |
|---|---|---|---|
| Juni 2026 | 26,68 USD | 22,42 USD | **WAF 16,00 USD** (Rest-Abrechnung aus der Zeit vor der WAF-Entfernung, Commit `f3431dd`), Tax 4,26, CloudWatch 3,80, Amplify 1,08, Route 53 1,02 |
| Juli 2026 | 7,58 USD | 6,37 USD | CloudWatch 3,60, Route 53 1,02, Secrets Manager 0,89, API Gateway 0,28 |
| August 2026 | 7,97 USD | 6,70 USD | CloudWatch 3,90, Secrets Manager 1,31, Route 53 1,02, DynamoDB 0,15, S3 0,12 |

**Einordnung:** Die Schätzung ~5–10 €/Monat ist bestätigt (August ≈ 8 USD ≈
7 €). Die Juni-Spitze stammt aus der WAF-Rest-Abrechnung vor der Entfernung.
Der Cost Explorer summiert den **gesamten Account** (kein Tagging je Stack) —
Secrets Manager (~1,30 USD), Amplify (~0,11 USD) sowie Bedrock/ECR-Kleinstreste
gehören nachweislich **nicht** zum EstimateNest-Stack (CDK-grep ohne
Secret-/Amplify-Nutzung). Der eigentliche Kern (CloudWatch-Logs, Route 53,
DynamoDB, S3, API Gateway; Lambda < 0,01 USD/Monat) liegt damit eher bei
~5 USD netto — die Annahme „Lambda ~1 Mio. Invocations dominiert" trifft
nicht zu, real dominieren Logs (CloudWatch) und die Domain (Route 53).
**Quartalsweise Sichtprüfung** per Cost Explorer (read-only), kein eigenes
Tooling (BK-009, 2026-09-04).

## 8. Umsetzungsplan (retrospektiv)

Die tatsächliche Entwicklung lief in Phasen — aus der Git-Historie
rekonstruiert:

1. **Foundation** (Initial commit → `e6d1458`): Monorepo-Grundgerüst, CDK-Stack,
   erste Deploy-Pipeline auf dev.
2. **CI-Härtung** (`955335b` → `660d42b`, PRs #1/#2): CORS, Build-vor-Test,
   Rollup-Native/Sharp-Probleme auf Ubuntu (→ SHARP_*-Env, `ROLLUP_NATIVE: 0`),
   npm-workspace-Protocol → file-Referenz.
3. **Funktionsaufbau WS** (`20626be` → `44cb555`): WebSocket-Handler,
   Broadcast-Fan-out, Teilnehmer-Liste, Name-ändern, Moderator-Controls,
   Runden-Historie, Singleton-WebSocketService.
4. **Auto-Reveal** (`d1c9bc2` → `69ddfee`): Countdown-Overlay, Vote-Dedup,
   Reveal bei Vollbesetzung.
5. **Architektur-Review P0–P2** (`e325cb0` → `6af3c11`): zentrale
   DynamoDB-Client/Logger, IAM-Rechte vervollständigt, Node 24-Upgrade.
6. **Vereinfachung** (`2b66bb8` → `3b1fc4a`): Blue/Green raus, On-Demand,
   GSI-Throughput-Fix (PAY_PER_REQUEST).
7. **Moderator + Tests** (`a84f03b` → `5c96754`): Moderator-Assignment,
   Phantom-Participant-Fix, lokale E2E + erster dev-smoke.
8. **Kosten & SEO** (`f3431dd` → `fbde091`): WAF raus, Prerender, Meta/Sitemap/
   robots, OG-Images, noindex auf dev.
9. **Incident-Härtung** (`74503b7`, `190dd84`): Geister-Teilnehmer,
   Doppel-Joins, Cross-Room-Leaks, Moderator-Reassignment-Härtung,
   Reveal-Guard, WS-Connect-Races — mit Regressions-Tests (Tasks 15–30 der
   Incident-Analyse).
10. **Pflege** (`cd102d8`): Deprecation-Resolution (uuid 11, ESLint 10,
    Vitest 3, jsdom 28, Actions v6/v7) — PR #18, verifiziert in dev.
11. **P2-Runde** (`051f5af` + `9733824` + `26809e5` + `22f794d`):
    Rename-Persistenz (BK-001), Backend-tsc-Fehler aufgelöst +
    Typecheck-CI-Gate (BK-003), Moderator-Vacancy auch beim Solo-Leave
    (BK-011), dev-smoke um 3 Szenarien gegen deployed dev erweitert
    (BK-004) — verifiziert mit dev-smoke 6/6.
12. **Wartungsblock** (`12f7a6e` + `cce5686` + `989e2ce`): zentrales
    `cors.ts`-Util und CORS-Header auf allen Pfaden der REST-Handler
    (BK-012), Repo-Hygiene per .gitignore (BK-006, Entscheidung
    „ignorieren"), Dependabot aktiviert (BK-010) — CI-Deploy
    #33882065353 grün, dev-smoke 6/6, Browser-CORS-Nachweis gegen
    deployed dev.

## 9. Risiken & bekannte Grenzen

- **Dev/Prod-Verhalten:** `local-server.ts` spiegelt Prod-Nachrichtenmechanik,
  aber Persistenz/Broadcast unterscheiden sich — E2E gegen lokal beweisen kein
  AWS-Verhalten (deshalb dev-smoke).
- **Passwortgeschützte Räume:** Erstbeiter-Claim nach Passwort-Verifikation
  behoben (Commits b0dbf25 + 37c4510, 2026-09-04). CORS-Header liegen seit
  Commit `12f7a6e` (BK-012) auf **allen** Pfaden aller REST-Handler über das
  zentrale `cors.ts`-Util (vorher fehlten sie u. a. bei `update-room`-403/404
  und `round-history` — der Browser blockte diese Antworten).
- **Moderator-Mechanik:** Vacancy wird auch beim Solo-Leave markiert (Commit
  26809e5, 2026-09-04, BK-011) — der Raum bleibt nie dauerhaft
  moderatorenlos; das dev-smoke-Handover-Szenario weist den Pfad gegen
  deployed dev nach (vor dem Fix rot, nach dem Deploy grün).
- **Dependabot/Deprecation-Pflege:** aktiviert seit 2026-09-04 (BK-010,
  Commit `989e2ce`) — wöchentliche npm- und Actions-Updates über das
  Wurzel-Lockfile, minor-and-patch gruppiert; Merge-Rhythmus: PRs nach
  dev-Verifikation (dev-smoke + test:e2e) mergen, nicht über Monate sammeln.
- **Kaltstarts:** erste WS-Nachricht kann verzögert sein — akzeptiert
  (Issue #12 am 2026-09-05 nach Triage als akzeptierte Grenze geschlossen;
  Warmup/Provisioned Concurrency würde dem Kosten-ADR widersprechen).

## 10. Runde 1 „betriebs-haertung" (2026-09-29)

Bestands-Runde auf unverändertem Stack (keine neue Nutzerfunktion, keine
UI-Änderung). Quelle: AWS-Log-Analyse vom 29.09.2026
(`/tmp/enlogs3/EstimateNest-Loganalyse-2026-09-29.md`, April–September,
~220k Events); Anforderungen: `requirements.md` Runde 1 (REQ-F-017–023,
REQ-NF-010–012). Umsetzung als Feature-Runde nach den bestehenden
GitHub-Actions-Deployregeln (dev automatisch nach Freigabe, prod nur mit
separater Freigabe).

### 10.1 Ausgangslage (belegte Befunde)

- **Stumme WS-Connect-Ablehnungen:** 23.09.: 558 Verbindungsversuche,
  38 erfolgreich, 520 abgelehnt (93 %) — 400/404/429 kehren aus
  `websocket-connect.ts` zurück, **bevor** irgendein Log geschrieben wird.
- **connectionCount-Drift:** 09-23-Welle deutet auf gedrifteten Zähler
  (BK-018-Altlast: tote Mappings ohne Count-Decrement); BK-018 heilt nur
  neue Vorfälle. Zusätzlich: jeder Reconnect führt das bedingte
  Count-ADD erneut aus (keine Reconnect-Erkennung in
  `websocket-connect.ts` Z.72–84) — Drift wächst also auch durch
  Idle-Closes (Befund 10.2/ADR-16).
- **Fan-out unter Last:** 09.09. bei 155 Verbindungen 82×
  TooManyRequestsException (WS-Stage Burst 20/Rate 5,
  `estimateneest-stack.ts` Z.276–281) und **10 endgültige
  Sendeverluste**; `ws-fanout.ts` behandelt 429 weder mit Retry noch
  als eigenen Fall, `sendToConnection` (`broadcast.ts` Z.110–111)
  retryt nur 410.
- **Beobachtungslücke:** keine API-GW-Access-Logs (REST und WS, deployed
  `AccessLogSettings: null`, `LoggingLevel: OFF`); REST-4xx-Bot-Traffic
  (bis ~1.000/Tag) erzeugt keine Lambda-Invocation und ist nirgends
  sichtbar.
- **Log-Bestand:** 19 Lambda-Log-Gruppen, alle `retention = None`
  (291,8 MB; davon 271,8 MB minütlich beschriebene scheduled-Gruppen).
- **Reconnect-Zyklen:** erfolgreiche Verbindungen im exakten
  10-Minuten-Takt; 09.10.–09.16. 87–91 % der Verbindungen mit aufgelöster
  Moderator-Vakanz (`moderator-present`) — Ursache siehe ADR-16.
- **dev-AccessDenied 02.09.:** einmaliger `AccessDeniedException` im
  Stale-Cleanup des Vote-Handlers — Ursache identifiziert, siehe ADR-15
  (kein Handlungsbedarf am Grant).
- **Dependabot (REQ-F-023, Sichtung):** beide roten PRs belegt —
  #39 tailwindcss 4 (PostCSS-Plugin ausgelagert → Major-Migration),
  #36 typescript 7 (typescript-eslint-Peer `<6.1.0`); Empfehlung:
  zurückstellen bzw. eigene Major-Runde. Kein Architekturbezug.

### 10.2 Entscheidungen (ADR-10 … ADR-16)

#### ADR-10: Rejection-Logging im WS-Connect (REQ-F-017)

- **Kontext:** Die drei Ablehnungspfade (`websocket-connect.ts` Z.36–47
  Zod-400, Z.59–67 404, Z.85–98 429) waren die einzigen stummen Pfade der
  WS-Kette; die 93-%-Welle vom 23.09. war nur als Metrik sichtbar.
- **Entscheidung:** Genau ein `logger.warn` je Rejection mit den
  verfügbaren, nicht geratenen Attributen (AK-17.3): 400 →
  `connectionId` + rohe `rawRoomId`/`rawParticipantId` + Fehlerpfade der
  Zod-Validierung (keine Payload-Dumps); 404 → `roomId`, `participantId`,
  `connectionId`; 429 → zusätzlich `connectionCount` (gemessener Ist-Wert
  aus ADR-11) und `maxParticipants`. Warn-Level (erwartbare Client-Fehler,
  keine Server-Fehler); bestehender PII-redigierter Logger.
- **Begründung/Einfachheit:** Kein neues Log-Format, keine Metriken —
  die vorhandene Logger-Infrastruktur reicht; die Selbstheilung (ADR-11)
  liefert dem 429-Log den Ist-Zähler ohne Zusatz-Call.
- **Konsequenzen:** +1 Log je Rejection (Volumen über Retention
  gedeckelt, ADR-14). Retry-Wellen aus Clients werden künftig direkt
  sichtbar.

#### ADR-11: connectionCount-Selbstheilung im Connect (REQ-F-018)

- **Kontext:** Ein gedrifteter Zähler blockiert Joins bis zum Room-TTL
  (14 Tage) mit 429; ein Reparatur-Skript ist Nicht-Ziel (ephemere Räume,
  Interview-Entscheid).
- **Entscheidung:** Nur im 429-Pfad des Connects (kein Background-Job):
  Schlägt das bedingte Count-ADD (Z.72–84) mit
  `ConditionalCheckFailedException` fehl, dann (1) konsistentes Query auf
  `ParticipantsTable` (`roomId`, `ConsistentRead: true`) → Ist-Zahl =
  Items mit gesetztem `connectionId`; (2) `UpdateItem` auf das
  Raum-META: `SET connectionCount = :measured` — nur wenn
  `measured < maxParticipants`, sonst direkt 429; (3) das bedingte ADD
  genau einmal wiederholen; bei erneutem CCF → 429 + Warn-Log.
  Korrektur wird geloggt (Raum, alt→neu, Anlass, AK-18.3).
- **Begründung:** Messung + Heilung + Join in einem Request (AK-18.1);
  `SET` auf den gemessenen Wert erzeugt nie negative Zähler (AK-18.2);
  die Bedingung des ADDs bleibt als Race-Schutz bestehen (ein
  gleichzeitiger legitimer Connect kann den Zähler nur um sein eigenes
  +1 verschieben — ±1-Fenster bewusst akzeptiert und bei ephemeren Räumen
  unkritisch). Konsistenter Read statt Cache (`cache.ts` TTL 3 s,
  eventual — für eine Renormierung ungeeignet).
- **Konsequenzen:** +1 Query +1 Update ausschließlich im (seltenen)
  429-Fall — kein Kostenrisiko im Normalfall. Reconnect-Schwäche des
  Count-ADD (jeder Reconnect zählt +1) wird durch die Heilung entschärft,
  die eigentliche Reconnect-Ursache behebt ADR-16.

#### ADR-12: Fan-out-Härtung + moderate Stage-Limits (REQ-NF-010)

- **Kontext:** 82× 429 / 10 Endverluste am 09.09.; Ursache war das
  Zusammenspiel aus allSettled-parallelem Fan-out (bis 50 Empfänger) und
  Burst 20/Rate 5.
- **Entscheidung:** (1) Stage-Limits moderat anheben: Burst 20 → **50**,
  Rate 5 → **10** (`estimateneest-stack.ts` Z.276–281) — Burst deckt
  einen vollen Raum-Fan-out (maxParticipants = 50) in einem Schub ab;
  (2) `ws-fanout.ts`: 429 erhält bis zu 3 Gesamtversuche mit kurzem
  Backoff (100/300 ms + Jitter); nach Erschöpfung Warn-Log „Failed to send
  to connection", **kein** Cleanup/Count-Decrement (429 heißt „zu
  schnell", nicht „weg" — Abgrenzung zu 410/403); (3) `sendToConnection`
  (`broadcast.ts`): 429 in die bestehende Retry-Familie aufnehmen
  (maxRetries 3, Backoff `100·2^(n-1)`; nach Erschöpfung `throw` wie
  bisher, Aufrufer loggt bereits).
- **Bewusst nicht:** Nachrichten-Bündelung (Mehrfach-Payloads wären eine
  Protokolländerung ohne belegten Bedarf) und Retry-Unendlich (Lambda-
  Laufzeitbudget). REST-Throttling/UsagePlan bleiben unverändert
  (Nicht-Ziel).
- **Rest-Risiko:** Bei anhaltender Drosselung über das Retry-Budget
  hinaus ist weiterhin ein Endverlust möglich — das Warn-Log macht ihn
  sichtbar; Verifikation unter Last gegen dev (AK-NF-10.3).

#### ADR-13: API-GW-Access-Logging für REST und WS (REQ-F-020)

- **Kontext:** Keine Access-Logs; die 4xx-/5xx-Lücke (Bot-Traffic ohne
  Lambda-Invocation) war der Kern der Beobachtungslücke (Bericht §3).
- **Entscheidung:** Je Umgebung zwei Log-Gruppen
  (`/aws/apigateway/estimatenest-<env>-rest` bzw. `-ws`) als
  `logs.LogGroup` mit 30 Tagen Retention; REST über
  `restApi`-`deployOptions` (`accessLogDestination`/`accessLogFormat`
  als Custom-JSON mit den Feldern
  requestId/sourceIp/status/latency/path/userAgent —
  `jsonWithStandardFields` liefert weder userAgent noch Latenz, beides
  ist für die Bot-Erkennung (AK-20.3) nötig);
  WS über den bereits vorhandenen CfnStage-Override (Z.276–281) um
  `accessLogSettings` (JSON: requestId, requestTime, status, routeKey,
  sourceIp, userAgent) ergänzt — eine Antwort-Latenz gibt es bei
  WebSocket-APIs nicht, `$context.requestTime` liefert den Zeitpunkt.
  Der REST-Stage-Name bleibt unverändert
  (CDK-Default „prod" auch in dev): eine Umbenennung würde das
  Custom-Domain-BasePathMapping berühren — bewusst nicht in dieser Runde.
- **Begründung:** Schließt die Lücke ohne App-Änderung; JSON-Format ist
  strukturiert auswertbar; Nutzung vorhandener Override-Stellen hält den
  Diff klein.
- **Konsequenzen:** Log-Volumen wenige MB/Monat (10.3). Deploy-
  Voraussetzung: Account-Einstellung `cloudwatchRoleArn` für die REST-
  API vorhanden (Prüfschritt 10.4/10.5).

#### ADR-14: Log-Retention per CDK für alle Gruppen (REQ-F-019)

- **Kontext:** 19 Bestandsgruppen ohne Retention; statische
  `logs.LogGroup`-Konstrukte mit gleichem Namen würden beim Deploy an
  `ResourceAlreadyExists` scheitern (Gruppen existieren real, Namen sind
  CFN-autogeneriert).
- **Entscheidung:** `logs.LogRetention` je Handler-Log-Gruppe
  (`logGroupName: /aws/lambda/<functionName>` — die Gruppe liegt unter
  dem Lambda-Präfix, nicht am reinen Funktionsnamen; Token-fähig, nur
  CR-Property) mit **30 Tagen** Standard, **14 Tagen** für die beiden
  Scheduled-Auto-Reveal-Gruppen (je Umgebung, Interview-Entscheid);
  die neuen Access-Log-Gruppen (ADR-13) direkt mit 30 Tagen. Der CR
  wirkt auch auf die bereits existierenden Gruppen.
- **Begründung:** Der LogRetention-CR ist der einzige kollisionssichere
  Weg für bestehende Gruppen (CDK nutzt denselben Mechanismus intern).
  30 Tage = Diagnosehorizont der Runde (Monatsvergleich); die
  minütlichen Scheduled-Gruppen (271,8 MB) sind der größte Hebel der
  CloudWatch-Kostenposition.
- **Konsequenzen:** Logs älter als die Retention werden gelöscht
  (bewusst; der Analyse-Bestand liegt extern gesichert vor). Erster
  Deploy legt die Retention über ~20 CR-Operationen an (idempotent).

#### ADR-15: IAM-Befund zum dev-Cleanup-AccessDenied (REQ-F-021)

- **Kontext:** Bericht-Empfehlung 7 vermutete eine fehlende
  **Delete**-Berechtigung im Vote-Handler. Die vollständige Log-Recherche
  dieser Runde (alle AccessDenied-Messages aus den Roh-Pulls) zeigt:
  Der einzige September-Fall (02.09., dev) war
  `dynamodb:UpdateItem` auf **RoomsTable** („Failed to clean up stale
  connection" = der Rooms-Count-Decrement des Fan-out-Cleanups); die
  April-Fälle (Participants-UpdateItem, Rounds-GSI-Query, Rounds-
  DeleteItem) stammen aus der Zeit vor der IAM-Vervollständigung
  (Architektur-Review P0–P2, `e325cb0`…`6af3c11`).
- **Entscheidung:** **Keine Grant-Änderung.** Der fehlende Grant
  (`dynamodb:UpdateItem` auf RoomsTable) ist in der Quelle bereits
  vorhanden (Z.526–533, Kommentar nennt exakt „connectionCount balance
  in broadcast cleanup"), deployte dev- **und** prod-Rolle deckungsgleich;
  seither keine AccessDenieds mehr (September-Welle bis 23.09. sauber).
  Zusätzlich Aktions-Bestandsaufnahme des heutigen Vote-Pfads gegen die
  Grants: alle genutzten Aktionen gedeckt (Rounds: Get/Query/Put/Update/
  Delete/Transact; Participants: Query + GSI/Update/Transact; Rooms:
  Get/Update/Transact; Votes: Query/Transact; RateLimit: Query/Put) —
  0 ungedeckte Aktionen. Least Privilege bleibt erhalten (keine Grants
  „auf Vorrat"). Verifikation: Nach dem dev-Deploy läuft der Cleanup-Pfad
  real im dev-smoke/Rejection-Szenario; danach Log-Check
  „AccessDenied = 0" (10.4, Schritt 5).
- **Konsequenzen:** REQ-F-021 wird ohne CDK-Änderung erfüllt; der
  Berichtswortlaut („Delete ergänzen") ist damit belegt korrigiert.

#### ADR-16: App-Level-Heartbeat gegen den 10-Minuten-Idle-Close (REQ-F-022)

- **Kontext:** WS-Verbindungen enden exakt im 10-Minuten-Takt. Recherche
  (generisch, ohne Projektinhalte): Der API-GW-WebSocket-Idle-Timeout
  (10 min) ist **nicht konfigurierbar**; Protokoll-Ping-Frames setzen ihn
  **nicht** zurück — nur App-Level-Nachrichten. Der Client
  (`websocket-client.ts`) hat keinerlei Keepalive; nach jedem Close
  reconnectet er (~1 s, Backoff 1,5^n bis ~5 s, Z.269) und sendet
  `join` — der Server nimmt ihn auf, was den Moderator-Vakanz-Pfad
  („rejoin nach Grace" → `moderator-present`) und unnötige
  Join-/Broadcast-Last erklärt: die 87–91-%-Vakanz-Rate der Welle.
- **Entscheidung:** Leichtgewichtiger **App-Level-Heartbeat**:
  neue Message-Typen `ping` (Client→Server) und `pong` (Server→Client)
  in `packages/shared/src/schemas.ts` (Zod, wie alle Typen); der Client
  sendet bei offener Verbindung **alle 5 Minuten** `ping` (halb so lang
  wie der 10-min-Timeout = Puffer); der Server beantwortet mit `pong`
  über `sendToConnection` an die eigene Verbindung (kein Broadcast,
  keine Store-Änderung); der Client ignoriert `pong`. Interval startet
  bei `open`, stoppt bei `close`/`disconnect`. Der Ping läuft durch das
  bestehende Rate-Limit (1 pro 5 min ≪ 20/s pro Connection+Typ).
  `local-server.ts` spiegelt ping/pong (CLAUDE.md-Gotcha:
  WS-Verhalten synchron halten). Bewusst nicht: Backoff-Umbau
  (1-s-Reconnect ist ohne Idle-Close unkritisch) und Server-seitiger
  Scheduled-Ping (Kosten/Aufwand schlechter als Client-Heartbeat).
- **Konsequenzen:** Der einzige nicht-protokollneutrale Punkt der Runde
  (neuer Typ; Annahme in requirements.md deckt genau diese Ausnahme).
  Bestehende Clients ohne `ping` funktionieren unverändert (kein
  Serverfehler, sie behalten nur ihr 10-min-Verhalten bis zum nächsten
  Reload); neue Clients senden `ping` erst nach Frontend-Deploy. Kein
  Moderator-Vakanz-Zyklus mehr durch Idle-Closes; Heartbeat-Kosten
  siehe 10.3.

### 10.3 Kostenschätzung der Runde (zusätzlich zu §7)

Beobachtetes Nutzungsprofil (Sep-Welle: ~13k WS-Messages/Monat Spitze);
Preisgrößenordnungen AWS eu-central-1, Stand 2026-09.

| Position | Annahme | Zusatz USD/Monat |
|---|---|---|
| Access-Logs REST+WS | ~1k 4xx/Tag REST + ~6k WS-Stage-Events/Monat ≈ 35–40 MB Ingest (0,50/GB) + 30 d Speicher | ~0,02–0,05 |
| Heartbeat (ping/pong) | 5-min-Intervall, ≤ 20 Nutzungsstunden/Monat × ≤ 50 Verbindungen ≈ ≤ 100k Messages; WS-Message 1,00/Mio + Lambda-Invocations | ~0,05–0,15 |
| Lambda-Selbstheilung/Retries | nur im 429-Fall; Volumen unbedeutend | < 0,01 |
| IAM/Throttling | keine neuen Kosten | 0 |
| Retention (ADR-14) | **Senkung** der CloudWatch-Speicherkosten (271,8 MB Scheduled-Logs ohne Ablauf) | negativ im Zeitverlauf |
| **Summe** | deutlich unter REQ-NF-012 (< 1 USD/Monat) | **< 0,25** |

Unsicherheiten: Access-Log-Volumen schwankt mit Bot-Traffic (bis
Faktor 2); exakte Cent-Beträge nach dem ersten vollen Monat messbar.
Quellen: aws.amazon.com/cloudwatch/pricing, aws.amazon.com/api-gateway/pricing
(Größenordnungen, keine Tiefenrecherche — Beträge sind weit unter jeder
Relevanzschwelle). Bestehendes Kostenversprechen (§7, ~5–10 €/Monat)
bleibt eingehalten.

### 10.4 Umsetzungsplan

1. **Shared:** `ping`/`pong`-Typen + Zod-Schemas (Grundlage für Backend,
   Frontend, local-server).
2. **Backend:** `websocket-connect.ts` — Rejection-Logging (ADR-10) +
   Selbstheilung (ADR-11); `ws-fanout.ts`/`broadcast.ts` — 429-Retry
   (ADR-12); `vote.ts` — `ping`-Case (pong-Antwort);
   `local-server.ts` — ping/pong-Spiegel. Tests: Rejection-Logs,
   429-Selbstheilung (gemessen >/< max), Fan-out-429-Retry.
3. **Frontend:** `websocket-client.ts` — Heartbeat-Interval (5 min,
   open/close-gebunden), pong-Handler; Tests.
4. **Infrastruktur:** Throttling 50/10 (ADR-12); Access-Log-Gruppen +
   Formate (ADR-13); LogRetention-Loop 30/14 Tage (ADR-14). `synth`
   validiert ohne Deploy.
5. **Verifikation (nach dev-Freigabe):** Gates (typecheck/lint/build/
   Vitest) → Push development → CI-Deploy dev → `test:dev-smoke` 6/6 +
   Runde-1-Szenarien (Drift/429-Pfad, fortlaufende Sitzung > 10 min ohne
   Reconnect, Fan-out unter Last) → Log-Checks: Access-Logs vorhanden,
   Retention aktiv (`describe-log-groups`), „AccessDenied = 0" (ADR-15).
6. **Dokumentation:** requirements-backlog/status, umsetzungsbericht;
   Pflege-Hinweis zu Dependabot-PRs #36/#39 (BK-010-Rhythmus).

Reihenfolge je Commit lauffähig; `docs/`-Spiegelung erst im Abschluss
(laut /anleitung).

### 10.5 Risiken

- **REST-Access-Logging benötigt Account-Einstellung**
  (`cloudwatchRoleArn`, API-GW-weit): Deploy-Vorprüfung
  `aws apigateway get-account`; falls leer, einmalig `CfnAccount` mit
  `AmazonAPIGatewayPushToCloudWatchLogs` ergänzen (kleinster Eingriff).
  WS-Access-Logs sind davon nicht betroffen.
- **LogRetention-CR-Dauer** beim ersten Deploy (~20 Gruppen,
  seriell) — einmalig, idempotent, kein Datenverlust.
- **Selbstheilungs-Race:** parallele Connects um den Renormierungs-
  Zeitpunkt können den Zähler um ±1 verschieben — bewusst akzeptiert
  (Bedingung des ADDs bleibt; ephemer). 
- **Fan-out-Rest-Risiko:** anhaltende Drosselung über das Retry-Budget
  hinaus → Endverlust bleibt möglich, aber geloggt (ADR-12).
- **Protokoll-Erweiterung ping/pong:** erfordert Shared-Build vor
  Backend/Frontend (bekannte Build-Reihenfolge, ADR-4); alte Clients
  bleiben kompatibel (kein Fehler ohne ping).
- **Stage-Name REST bleibt „prod" in beiden Umgebungen** — bewusst
  (Umbenennung würde das BasePathMapping der Custom Domain berühren);
  als bekannte kosmetische Abweichung dokumentiert.

# Architektur: EstimateNest

> **Hinweis Backfill:** Rekonstruiert aus dem vorhandenen Code
> (`~/WebstormProjects/EstimateNest`) und dessen CLAUDE.md. ADRs sind
> retrospektiv als „Entscheidung + Begründung" festgehalten. Umsetzung ist
> bereits abgeschlossen und live (dev + prod).

- datum: 2026-09-04
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

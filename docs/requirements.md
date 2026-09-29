# Requirements: EstimateNest

> **Hinweis Backfill:** Rekonstruiert aus dem vorhandenen Code
> (`~/WebstormProjects/EstimateNest`). Prioritäten sind retrospektiv als
> „Muss/Kann" eingeordnet; die Acceptance-Kriterien (AK) beschreiben das
> tatsächlich implementierte Verhalten.

- datum: 2026-09-04
- quelle: ideen.md, Rekonstruktion aus dem Bestandscode

Legende Priorität: **M** = Muss, **K** = Kann.

## Überblick

Eine sign-up-freie Planning-Poker-Web-App: Räume werden per 6-stelligem Code
geteilt, der erste Teilnehmer wird Moderator, alle Stimmen laufen in
Echtzeit über WebSocket. Drei Decks + Custom-Deck, Auto-Reveal mit Countdown,
Runden-Historie mit Durchschnitt, optionaler Passwort-Schutz. Räume verfallen
nach 14 Tagen. Serverless auf AWS; automatischer Deploy auf dev und prod.

---

## Funktionale Anforderungen

### REQ-F-001 — Raum erstellen
**Priorität:** M

Ohne Konto wird ein Raum mit kurzem Code erstellt.

- **AK-01.1:** Über die Landing-Page lässt sich ein Raum mit optionalem Namen,
  optionalem Moderator-Passwort und gewähltem Deck erstellen.
- **AK-01.2:** Der Raum erhält einen eindeutigen, kurzen Code (~6 Zeichen).
- **AK-01.3:** Nach dem Erstellen wird eine teilbare Raum-URL mit Copy-Button
  angezeigt; der Ersteller landet nicht automatisch im Raum.

### REQ-F-002 — Raum beitreten
**Priorität:** M

Ein Teilnehmer tritt über den Code bzw. die Raum-URL bei.

- **AK-02.1:** Beitritt über URL `/<code>` oder direkte Code-Eingabe mit Name.
- **AK-02.2:** Ohne Namen gilt „Anonymous"; der Avatar wird deterministisch aus
  einem Seed erzeugt (kein Avatar-Picker).
- **AK-02.3:** Bei passwortgeschützten Räumen werden die Fehlercodes
  `PASSWORD_REQUIRED` bzw. `INCORRECT_PASSWORD` abgefangen und ein
  Passwort-Dialog angezeigt.
- **AK-02.4:** Der erste Teilnehmer eines Raums wird Moderator
  (transaktionaler Claim via CAS auf `moderatorAssigned`, nur einmal
  möglich). In passwortgeschützten Räumen kann den Claim nur ein
  verifizierter Teilnehmer auslösen; der Ersteller tritt beim Erstellen
  mit dem Passwort automatisch bei und wird so in der Regel der Moderator.

### REQ-F-003 — Identität über Reload erhalten
**Priorität:** M

Ein Reload der Raum-Seite erzeugt keine doppelte Teilnehmer-Zeile.

- **AK-03.1:** Teilnehmer-Identität (participantId + Name) wird je Raum in
  sessionStorage gehalten.
- **AK-03.2:** Nach Reload wird mit derselben participantId rejoined; Name und
  Moderator-Rolle bleiben erhalten. (Auch nach „Name ändern": die
  Rename-Persistenz-Lücke ist seit 2026-09-04 geschlossen, Commit 051f5af,
  BK-001.)
- **AK-03.3:** Ein Raum-Wechsel (andere URL) leert die Stores vollständig —
  keine State-Leaks zwischen Räumen.

### REQ-F-004 — Raum verlassen
**Priorität:** M

- **AK-04.1:** „Leave Room" trennt die Verbindung und führt zur Startseite.
- **AK-04.2:** Nach dem Schließen des Tabs / Verbindungsabbruch verschwindet der
  Teilnehmer aus der Liste aller Clients ohne manuellen Refresh (keine
  „Geister-Teilnehmer").

### REQ-F-005 — Decks
**Priorität:** M

- **AK-05.1:** Es stehen drei Decks zur Verfügung: Fibonacci
  `[0,1,2,3,5,8,13,20,40,100,?,☕]`, T-Shirt `[XS,S,M,L,XL,XXL,?,☕]` und
  Zweierpotenzen `[0,1,2,4,8,16,32,64,?,☕]`.
- **AK-05.2:** Ein Custom-Deck ist als kommagetrennte Liste definierbar
  (2–15 Werte; Zahlen numerisch, Texte als Sonderkarten).
- **AK-05.3:** `?` (unsicher) und `☕` (Pause) sind feste Sonderkarten jedes Decks.

### REQ-F-006 — Voting-Runde
**Priorität:** M

- **AK-06.1:** Der Moderator startet eine neue Runde, optional mit Titel
  (≤ 200 Zeichen) und Beschreibung (≤ 1000 Zeichen).
- **AK-06.2:** Jeder Teilnehmer votet durch Kartenwahl; nach dem ersten Vote ist
  die Auswahl für die laufende Runde gesperrt.
- **AK-06.3:** Die Kartenauswahl wird beim Start einer neuen Runde zurückgesetzt
  (keine Alt-Auswahl in der Folgerunde).
- **AK-06.4:** Nur der Moderator darf Titel/Beschreibung der laufenden Runde
  ändern.

### REQ-F-007 — Aufdecken (Reveal)
**Priorität:** M

- **AK-07.1:** Der Moderator deckt die Stimmen auf; die Ergebnisse (inkl.
  Sonderkarten) werden allen angezeigt.
- **AK-07.2:** Ist „Alle dürfen aufdecken" aktiv, kann jeder Teilnehmer
  aufdecken; andernfalls erhalten Nicht-Moderatoren einen Fehler.
- **AK-07.3:** Ein Reveal-Guard verhindert, dass ein veralteter/überholter
  Reveal-Zustand die aktuelle Runde überschreibt.

### REQ-F-008 — Auto-Reveal mit Countdown
**Priorität:** K

- **AK-08.1:** Ist Auto-Reveal aktiv, startet nach dem letzten Vote ein
  Countdown (Default 3 s), den alle Clients als Overlay sehen.
- **AK-08.2:** Nach Ablauf wird automatisch aufgedeckt (über den normalen
  Reveal-Pfad); ein Scheduled-Lambda fungiert als Ausfall-Sicherung.
- **AK-08.3:** Auto-Reveal ist vom Moderator an-/abschaltbar.

### REQ-F-009 — Durchschnitt & Runden-Historie
**Priorität:** K

- **AK-09.1:** Nach dem Reveal wird der Durchschnitt der Zahlenwerte berechnet
  und angezeigt (Sonderkarten `?`/`☕` fließen nicht ein).
- **AK-09.2:** Aufgedeckte Runden erscheinen in der Runden-Historie (Titel,
  Datum, Stimmen, Durchschnitt) und werden beim Reveal nachgeladen.

### REQ-F-010 — Moderator-Steuerung (Einstellungen)
**Priorität:** M

- **AK-10.1:** Der Moderator kann Auto-Reveal aktivieren/deaktivieren.
- **AK-10.2:** Der Moderator kann ein Passwort setzen, ändern und entfernen.
- **AK-10.3:** Der Moderator kann das Deck des Raums wechseln.
- **AK-10.4:** Alle Einstellungs-Änderungen werden serverseitig auf
  Moderator-Rechte geprüft (403 ohne `isModerator`).

### REQ-F-011 — Moderator-Übergabe
**Priorität:** M

- **AK-11.1:** Verlässt der Moderator den Raum, beginnt eine Grace-Frist
  (60 s).
- **AK-11.2:** Danach wird beim nächsten Join/Connect/einer Nachricht der
  älteste anwesende Teilnehmer transaktional zum Moderator befördert
  (Conditions verhindern Wettläufe).
- **AK-11.3:** Ein reconnectender Moderator erhält seine Rolle zurück, solange
  kein anderer befördert wurde.

### REQ-F-012 — Teilnehmer Name ändern
**Priorität:** M

- **AK-12.1:** Teilnehmer können ihren Namen live ändern; die Änderung wird an
  alle übertragen (`participantUpdated`) und in der Teilnehmerliste
  aktualisiert.

### REQ-F-013 — Teilnehmerliste & Verbindungsstatus
**Priorität:** M

- **AK-13.1:** Die Teilnehmerliste zeigt alle anwesenden Teilnehmer inkl.
  Verbindungsindikator und Moderator-Markierung (👑).
- **AK-13.2:** Aktualisierungen der Liste kommen als Broadcast
  (`participantList`); die Anzeige „Participants (n)" zählt nur anwesende
  Teilnehmer.

### REQ-F-014 — Raum-Schutz & Limits
**Priorität:** M

- **AK-14.1:** Die maximale Teilnehmerzahl beträgt 50 (Default) und wird beim
  WebSocket-Connect durchgesetzt.
- **AK-14.2:** Räume verfallen automatisch nach 14 Tagen (DynamoDB-TTL).

### REQ-F-015 — Landing-Page (Produkt-Sicht)
**Priorität:** M

- **AK-15.1:** Die Landing-Page erklärt das Produkt („Free · No sign-up"),
  zeigt 6 Feature-Karten, FAQs und Footer mit Impressum/Datenschutz.
- **AK-15.2:** SEO: Die Landing-Page ist prerendert (statisches HTML), enthält
  Meta-Tags, OG/Twitter-Tags, JSON-LD und Canonical; `robots.txt` + `sitemap.xml`
  werden ausgeliefert.

### REQ-F-016 — Rechtliches
**Priorität:** M

- **AK-16.1:** Impressum und Datenschutzerklärung sind unter `/legal`
  erreichbar und verlinkt.

---

## Nicht-funktionale Anforderungen

### REQ-NF-001 — Echtzeit-Fan-out
**Priorität:** M

- **AK:** Voting-, Teilnehmer- und Runden-Änderungen erreichen alle Clients
  innerhalb < 1 s über WebSocket-Broadcasts (API Gateway
  ApiGatewayManagementApi).

### REQ-NF-002 — Bootstrap nur über REST
**Priorität:** M

- **AK:** REST (`POST /rooms`, `GET /rooms/{code}`) dient nur der
  Initialisierung (Raum anlegen/beitreten); der gesamte Echtzeit-Zustand
  fließt über WebSocket.

### REQ-NF-003 — Robustheit bei Verbindungsabbruch
**Priorität:** M

- **AK:** Nach einem WebSocket-Verlust pollt der Client per REST-Join
  (5 s-Basis, exponentieller Backoff bis 30 s) und verbindet sich automatisch
  neu; ein Wechsel zu „connecting/disconnected" wird im UI angezeigt.
- **AK:** Handlers bleiben über Reconnects registriert; kein hängenbleibender
  „connecting"-Zustand.

### REQ-NF-004 — Konsistenz (keine Geister, keine Doppelten)
**Priorität:** M

- **AK:** Verlassen/Disconnect dekrementiert den Verbindungszähler
  transaktional gebunden an die Teilnehmer-Entfernung.
- **AK:** Doppelte Joins / Wettlauf-Situationen erzeugen keine doppelten
  Teilnehmer-Zeilen; Store-Aktualisierungen verwerfen veraltete Runden.
- **AK:** Vote-Transaktionen mit Konflikt werden mit Backoff-Retry
  (max. 5 Versuche) ausgeführt.

### REQ-NF-005 — Sicherheit
**Priorität:** M

- **AK:** Alle REST-Endpunkte (außer Health) sind durch einen API-Key
  (`x-api-key`) geschützt; API-Gateway-Throttle 5 rps / Burst 20.
- **AK:** WebSocket-Nachrichten sind pro Verbindung und Typ auf 20 Nachrichten/s
  begrenzt (DynamoDB-basiertes Rate-Limit).
- **AK:** Moderator-Passwörter werden nur gehasht gespeichert; Logs sind
  strukturiert und PII-redigiert.

### REQ-NF-006 — Serverless & Kosten
**Priorität:** M

- **AK:** Backend läuft als Lambda (Node 24) hinter API Gateway (REST +
  WebSocket); Datenhaltung in DynamoDB (PAY_PER_REQUEST, keine
  Blue/Green-Wartung).
- **AK:** Laufende Kosten bleiben im Cent-/niedrigen-Euro-Bereich pro Monat
  (kein WAF, keine festen Instanzen).

### REQ-NF-007 — Deploy & Umgebungen
**Priorität:** M

- **AK:** CDK-Stack (Infrastructure-as-Code) für zwei Umgebungen (dev, prod);
  Push auf `development` deployt automatisch nach dev, Push auf `main` nach
  prod.
- **AK:** Die dev-Umgebung liefert `noindex,nofollow` (nie ranken); prod liefert
  `index,follow`.

### REQ-NF-008 — Tests
**Priorität:** M

- **AK:** Vitest-Unit-/Integrationstests: Backend 117, Frontend 32 — grün.
- **AK:** Playwright-E2E: lokale Szenarien (smoke, scenarios inkl.
  Disconnect/Reconnect, seo) und `dev-smoke` gegen die deployed dev-Umgebung
  (6 Tests: SEO ×2; Multi-User mit 3 Teilnehmern und 3 Runden inkl.
  Durchschnitt „8.7"/„2.0" und Sonderkarte „?"; Passwort-Raum; Auto-Reveal-
  Countdown; Moderator-Handover nach Solo-Leave).
- **AK:** CI führt Lint, Build und Tests auf jedem Push/PR aus.

### REQ-NF-009 — Wartbarkeit
**Priorität:** K

- **AK:** Monorepo mit npm-Workspaces und gemeinsamen Typen/Zod-Schemas in
  `packages/shared`; Build-Reihenfolge shared → backend → frontend
  (tsup-Bundling ist load-bearing).

---

## Annahmen

- Der Raum-Ersteller tritt nach dem Erstellen automatisch bei (Auto-Join mit
  seiner participantId; in Passwort-Räumen wird das Passwort mitgesendet).
  Der Erstbeiter-Claim macht den ersten Verifizierten zum Moderator.
- Verlässt der Moderator den Raum als letzter Teilnehmer, wird die Vacancy
  trotzdem markiert und ein späterer Beitritt befördert den ältesten
  anwesenden Teilnehmer nach der 60-s-Grace (seit 2026-09-04, Commit
  26809e5, BK-011) — der Raum bleibt nie dauerhaft moderatorenlos.
- Sonderkarten (`?`, `☕`) zählen nicht in den Durchschnitt.
- Keine Nutzerkonten, keine serverseitige Speicherung von Personendaten über
  die 14-Tage-TTL hinaus.

## Nicht-Ziele

- User-Accounts, Teams, Organisationen, Berechtigungs-Rollen
- Teilnehmer entfernen (Kick), Avatar-Auswahl, Sprachumschaltung
- Raum-Einstellungen über den Ablauf hinaus speichern; Raum-Wiederbeleben
- Native Mobile-Apps
- Monetarisierung (Werbung, Premium)

## Offene Punkte

Keine offenen Punkte (Stand 2026-09-04): die beiden dokumentierten Lücken —
Rename-Persistenz (BK-001, Commit 051f5af) und Solo-Leave-Moderator (BK-011,
Commit 26809e5) — sind behoben. Verbleibende Backlog-Items sind P3/laufend
(BK-005 bis BK-010, BK-012).

---
---

# Runde 1 — betriebs-haertung (2026-09-29)

- datum: 2026-09-29
- quelle: AWS-Log-Analyse 2026-09-29 (Voll-Historie April–September,
  ~220k Events; Bericht `/tmp/enlogs3/EstimateNest-Loganalyse-2026-09-29.md`),
  Interview mit dem User am 2026-09-29
- auftrag: Top-Empfehlungen 1–8 des Berichts umsetzen, Empfehlung 9 (Dependabot)
  als Kurz-Sichtung
- kontext: Bestands-App auf unverändertem Stack (AWS serverless, React 19);
  keine neue Nutzerfunktion, keine UI-Änderung — Betriebs-, Beobachtungs- und
  Robustheits-Härtung nach der ersten Nutzungswelle (September 2026)

## Funktionale Anforderungen (Runde 1)

### REQ-F-017 — WS-Connect: Ablehnungen werden geloggt
**Priorität:** M (Empfehlung 1)

Heute kehren 400 (Zod-Validierung), 404 („Room not found") und 429
(„Connection limit exceeded") aus `websocket-connect.ts` zurück, **bevor**
irgendein Log geschrieben wird (Bericht §3). Der 09-23-Kernbefund (520 von
558 Verbindungsversuchen abgelehnt) war dadurch nur als Metrik sichtbar.

- **AK-17.1:** Jede abgelehnte WS-Verbindung erzeugt genau einen
  strukturierten WARN-Log mit Ursache (Validierungsfehler / Raum nicht
  gefunden / Limit erreicht) und den verfügbaren Kontext: `roomId`,
  `participantId` (soweit vorhanden), `connectionCount`, `maxParticipants`.
- **AK-17.2:** Der Log folgt dem bestehenden strukturierten, PII-redigierten
  Logger-Format (`logger.warn`), keine Roh-Payload-Dumps.
- **AK-17.3:** Attribute ohne Aussage (z. B. participantId bei fehlgeschlagener
  Validierung) werden weggelassen statt geraten.

### REQ-F-018 — connectionCount-Drift: Selbstheilung im Connect
**Priorität:** M (Empfehlung 2)

Die 09-23-Ablehnungswelle deutet auf einen gedrifteten `connectionCount`
im Raum-Item (BK-018-Altlast: tote Mappings ohne Count-Decrement entfernt).
BK-018 heilt nur neue Vorfälle; bestehende Drift bleibt bis zum TTL-Ablauf
in den Daten. Entscheidung (Interview): **Selbstheilung im Connect-Pfad**,
kein separates Reparatur-Skript (Räume sind mit 14 Tagen ephemer).

- **AK-18.1:** Erhält ein Raum-Connect eine 429-Ablehnung, prüft der Handler
  den Zähler gegen die tatsächlich vorhandenen Teilnehmer/Verbindungen; bei
  Abweichung wird der Zähler auf den Ist-Wert korrigiert und der Join
  gelingt im selben Request (kein Fehlversuch für den Client).
- **AK-18.2:** Die Korrektur ist bedingt (CAS/ConditionExpression) und
  renormiert nur auf den gemessenen Ist-Wert — sie erzeugt weder negative
  Zähler noch überschreibt sie gleichzeitige legitime Verbindungen
  (keine Race-Regression).
- **AK-18.3:** Jede Korrektur wird geloggt (Zähler alt → neu, Raum, Anlass).
- **AK-18.4:** Ein Raum mit gedriftetem Zähler erzeugt keine dauerhafte
  429-Blockade mehr (verifiziert: Rejoin gelingt, Roster konsistent).

### REQ-F-019 — Log-Retention für alle Log-Gruppen
**Priorität:** M (Empfehlung 5)

Alle 19 EstimateNest-Log-Gruppen stehen auf `retention = None` („never
expire", 291,8 MB und wachsend; davon 271,8 MB in den minütlich
beschriebenen scheduled-Gruppen). Entscheidung (Interview):
**30 Tage Standard, 14 Tage für die beiden scheduled-Auto-Reveal-Gruppen**
(je Umgebung).

- **AK-19.1:** Jede EstimateNest-Log-Gruppe (dev + prod) hat eine
  Retention per CDK/IaC — 30 Tage Standard, 14 Tage für die
  scheduled-Auto-Reveal-Gruppen.
- **AK-19.2:** Keine manuellen Klicks; die Werte sind im Stack definiert und
  nach Deploy per `aws logs describe-log-groups` verifiziert.

### REQ-F-020 — API-Gateway-Access-Logging (REST + WebSocket)
**Priorität:** M (Empfehlung 4)

Ablehnende REST-Requests (Bot-/Scanner-Traffic, bis ~1.000 4xx/Tag an
nutzungsfreien Tagen) erzeugen keine Lambda-Invocation und sind damit
nirgends sichtbar. Entscheidung (Interview): Access-Logging aktivieren
(Kostenschätzung: wenige MB/Monat, deutlich unter 1 USD).

- **AK-20.1:** REST-API und WebSocket-API (dev + prod) schreiben
  Access-Logs im JSON-Format in je eine eigene Log-Gruppe mit definierter
  Retention (gemäß REQ-F-019).
- **AK-20.2:** Die Logs enthalten mindestens: requestId, Zeitpunkt, Quelle
  (sourceIp), Status/StatusCode, Route bzw. Path, Latenz, userAgent.
- **AK-20.3:** Ein 4xx-Request ohne Lambda-Invocation (Bot-Traffic) ist im
  Access-Log eindeutig erkennbar.

### REQ-F-021 — IAM-Lücke im dev-Stale-Cleanup schließen
**Priorität:** M (Empfehlung 7)

Am 09.02. (dev-Testtag) schlug der Stale-Cleanup des Vote-Handlers einmalig
mit `AccessDeniedException` fehl („Failed to clean up stale connection");
Einzelfall, aber ein echter Berechtigungsmangel der Handler-Rolle.

- **AK-21.1:** Die Ursache (fehlender Grant auf den im Cleanup genutzten
  DDB-Call) ist identifiziert; der Grant wird über CDK ergänzt (dev; sofern
  die Analyse eine Lücke in prod zeigt, dort ebenfalls).
- **AK-21.2:** Der Cleanup-Pfad läuft nach dem Deploy ohne AccessDenied
  (Nachweis per Log/Metric oder gezieltem Test).

### REQ-F-022 — Client-Reconnect-Verhalten (10-Min-Zyklen)
**Priorität:** S (Empfehlung 8)

Beobachtet: erfolgreiche Verbindungen im exakten 10-Minuten-Takt
(API-GW-Idle-Timeout + Client-Reconnect) und 87–91 % Verbindungen mit
aufgelöster Moderator-Vakanz (Reason `moderator-present`) in der
Nutzungswelle 09.10.–09.16. Entscheidung (Interview): **analysieren und
bei eindeutigem Befund fixen.**

- **AK-22.1:** Ursache verifiziert und dokumentiert: Idle-Timeout der
  WS-Verbindung vs. Client-Reconnect-Strategie (Backoff, Keepalive-Fehler);
  nachgewiesen mit realem Verbindungsverlauf (Logs/Frames), nicht nur
  vermutet.
- **AK-22.2:** Bei eindeutigem Befund wird der Fix umgesetzt (z. B.
  leichtgewichtiges Keepalive/Ping oder Reconnect-/Backoff-Anpassung im
  Frontend), sodass eine aktive Sitzung nicht alle 10 Minuten
  neu aufgebaut werden muss.
- **AK-22.3:** Verifikation gegen deployed dev (fortlaufende Sitzung über
  > 10 Minuten ohne Neuaufbau bzw. ohne Vakanz-Auflösung durch Reconnect).

### REQ-F-023 — Dependabot-PR-Sichtung (Sichtung, kein Merge-Zwang)
**Priorität:** K (Empfehlung 9)

Zwei Dependabot-PR-Checks schlugen fehl (tailwindcss 4.3.3,
typescript 7.0.2); seither keine Deploys/PR-Aktivität.

- **AK-23.1:** Beide PRs sind gesichtet; die Fehlschlag-Ursache (Build/Test
  unter dem Bump) ist benannt und je PR eine Empfehlung dokumentiert
  (mergen mit Fix / zurückstellen / schließen). Die Umsetzung ist nicht
  Teil dieser Runde (läuft weiter als BK-010).

## Nicht-funktionale Anforderungen (Runde 1)

### REQ-NF-010 — Kein endgültiger Nachrichtenverlust im Fan-out
**Priorität:** M (Empfehlung 3)

Am 09.09. gingen unter der Last von 155 Verbindungen 10 Fan-out-Nachrichten
endgültig verloren („Failed to send message after all attempts"); Ursache war
das WS-Stage-Throttling (Burst 20 / Rate 5) — 82× TooManyRequests im
Vote-Handler. Entscheidung (Interview): **App-seitig härten und die
Stage-Limits moderat anheben.**

- **AK-NF-10.1:** Das Fan-out behandelt 429 mit Retry/Backoff so, dass
  Nachrichten unter Lastspitzen nicht endgültig verloren gehen (bzw. die
  verbleibende Verlustwahrscheinlichkeit nachweislich minimiert ist —
  „after all attempts"-Fälle wie am 09.09. treten nicht mehr auf).
- **AK-NF-10.2:** Die WS-Stage-Limits werden moderat angehoben (Richtwert
  aus dem Interview: Burst ~50 / Rate ~10; exakte Werte legt die Architektur
  fest) — inkl. Begründung des Rest-Risikos (Missbrauchsschutz).
- **AK-NF-10.3:** Verifikation unter Last gegen deployed dev (Fan-out mit
  vielen Verbindungen, keine endgültigen Verluste).

### REQ-NF-011 — dev-smoke-Verifikation nach dem Deploy
**Priorität:** S (Empfehlung 6)

Seit dem 07.09. gab es keine dev-Nutzung; dev-smoke ist die einzige reale
Abdeckung der AWS-Pfade (Auto-Reveal, geteiltes Fan-out, Moderator-Handover).
Entscheidung (Interview): **einmalige Verifikation in dieser Runde** —
keine neue CI-Automatik.

- **AK-NF-11.1:** Nach dem dev-Deploy dieser Runde läuft `dev-smoke`
  (6 Szenarien) gegen `https://dev.estimatenest.net` — 6/6 grün.
- **AK-NF-11.2:** Zusätzlich Mindest-Coverage der Runde-1-Änderungen:
  Auto-Reveal-Zyklus (Fan-out-Pfad) und ein Rejection-/Drift-Szenario
  (z. B. 429-Pfad) sind real gegen deployed dev belegt.

### REQ-NF-012 — Kostenrahmen der Observability-Erweiterung
**Priorität:** M

- **AK:** Die durch Access-Logging und geänderte Retention erzeugten
  CloudWatch-Kosten bleiben im Cent-Bereich (< 1 USD/Monat bei beobachtetem
  Traffic); das bestehende Kostenversprechen (REQ-NF-006, Cent-/niedriger
  Euro-Bereich) bleibt eingehalten.

## Annahmen (Runde 1)

- Die WS-Stage-Limit-Anhebung erfolgt moderat als Richtwert Burst 50 /
  Rate 10; die Architektur validiert die konkreten Werte gegen das
  beobachtete Lastprofil (155 Verbindungen, ~82 Throttles an Spitzentagen).
- Die Drift-Selbstheilung arbeitet nur im 429-Pfad des Connects (kein
  periodischer Background-Job); bei ephemeren Räumen genügt das.
- Access-Logs enthalten Quell-IPs (übliche Server-Logs, berechtigtes
  Interesse IT-Sicherheit) — Aufbewahrung gemäß Retention (30 Tage);
  die Datenschutzseite im Repo bleibt inhaltlich unverändert gültig.
- Der Dependabot-Hinweis bleibt Sichtung; Merges erst nach dev-Verifikation
  im laufenden BK-010-Rhythmus.
- Alle Änderungen sind protokollneutral für Clients (keine Message-Typ-,
  Payload- oder UI-Änderung) — mit Ausnahme des Reconnect-Fixes (REQ-F-022),
  der ausschließlich Client-Verhalten betrifft.

## Nicht-Ziele (Runde 1)

- Kein Reparatur-Skript für Bestandsräume (Drift heilt im Connect bzw.
  verfällt per TTL).
- Keine dauerhafte/scheduled dev-smoke-Automatisierung.
- Keine Änderung an REST-Throttling oder API-Key-Mechanik.
- Keine UI-/Design-Änderungen (Design-Gate nicht berührt).
- Keine Zusammenführung/Überarbeitung der BK-021–BK-028-Simplify-Findings in
  dieser Runde.
- Kein Prod-Deploy ohne separate Freigabe (globale Deploy-Regel).

## Offene Punkte (Runde 1)

- Konkrete Werte/Dimensionierung von Drift-Selbstheilung, Fan-out-Backoff
  und Stage-Limits → Architektur (Phase 3); keine Rückfrage an den User.
- Reconnect-Fix-Variante (Keepalive vs. Backoff-Anpassung) → Architektur nach
  Verifikation des Ursachenbefunds.
- Exakter fehlender Grant im dev-Cleanup → bei der Architektur/Umsetzung
  gegen die CDK-Definition geprüft.

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

# Go-Live: EstimateNest

- datum: 2026-09-04 (Backfill-Dokumentation; Live-Betrieb läuft bereits);
  aktualisiert 2026-09-29 (Runde 1 „betriebs-haertung")
- basis: architektur.md, umsetzungsbericht.md, qa-code-bericht.md (PASS),
  qa-ui-bericht.md (PASS)
- stand: Runde 1 lokal abgeschlossen und reviewt (QA-Code-PASS 2026-09-29,
  QA-UI-PASS 2026-09-29), **Änderungen uncommitted auf `development`** —
  Deployment steht noch aus (Push = CI-Deploy dev, nur nach Freigabe).
  Davor: prod main `2b2a95c` (2026-09-05) — **Prod-Sync PR #33**: BK-015
  (CloudFront-Cache-Fix, `8f4006a`) + BK-016 (Leave-Ghosting-Fix,
  `990a36a`) sind auf prod (CI-Deploy #33976704657 grün, prod-verifiziert);
  davor PR #32 (`5869a6d`): Major-Upgrade-Runde #23–#31 (`fbdad74`) +
  Dependabot-`target-branch: development` (877824f). main ist Vorfahr von
  development; **dev deployed auf `66f43ff` (2026-09-07)**: Simplify-
  Wartungsblock BK-018/017/019/020 (Commits `ba51591`, `9fa0c06`,
  `3def695`, `66f43ff` — gemeinsames WS-Fan-out, Round-Mapping+TTLs+
  Reveal-Race-Guard, zentraler Participant-Lookup, konsistenter
  Votes-Read; CI-Deploy #34139739387 grün, dev-smoke 6/6). **Prod-Sync
  PR #34 → main `5d6c8af` (2026-09-07, Merge ohne `--delete-branch`)**:
  der Wartungsblock ist auf prod (Prod-Deploy #34140744945 grün,
  prod-verifiziert — Health 200, Frontend 200); prod und development
  inhaltlich synchron (66f43ff in main enthalten)

## Überblick

Web-App (React) + Serverless-AWS-Backend, live in zwei Umgebungen:
- **prod** → https://estimatenest.net
- **dev** → https://dev.estimatenest.net (noindex)

Deploy vollautomatisch über GitHub Actions: Push auf `development` deployt
dev, Push auf `main` deployt prod. Keine manuellen Deploy-Schritte.

## Runde 1 „betriebs-haertung" — vorbereiteter Stand (2026-09-29)

Was der nächste dev-Deploy mitbringt (Details: architektur.md §10, ADR-10–16;
umsetzungsbericht.md):

- **Observability:** WS-Connect-Ablehnungen werden geloggt (400/404/429,
  ADR-10); API-GW-Access-Logs für REST **und** WS in neuen Log-Gruppen
  `/aws/apigateway/estimatenest-<env>-rest|-ws` (ADR-13); Log-Retention über
  9 `LogRetention`-Ressourcen: 8 Handler 30 Tage, `scheduled-auto-reveal`
  14 Tage (ADR-14, behebt „never expire").
- **Robustheit:** connectionCount-Drift-Selbstheilung im 429-Pfad (ADR-11),
  429-Retry im WS-Fan-out (3 Versuche, 100/300 ms + Jitter, kein Cleanup bei
  429; ADR-12), WS-Stage-Throttling moderat angehoben (Burst 50 / Rate 10),
  App-Level-Heartbeat `ping`/`pong` alle 5 min gegen den 10-min-Idle-Timeout
  von API Gateway (ADR-16).

Deploy-Besonderheiten:

- 9 neue `Custom::LogRetention`-Ressourcen — deren erstmalige Erstellung
  dauert einige Minuten (Lambda-Aufruf hinter CloudFormation); im
  Workflow-Log sichtbar, kein Eingreifen nötig.
- Protokollerweiterung `ping`/`pong` ist **additiv** (kein Breaking Change);
  REST-Stage-Name „prod" bleibt unverändert (BasePathMapping!).
- Erwartete Downtime: keine.

Verifikation nach dem dev-Deploy (erledigt die deploy-abhängigen AKs aus
qa-code-Bericht; Kommandos aus Projekt-Konventionen):

1. `npm run test:dev-smoke` → 6/6 grün (REQ-NF-011).
2. Runde-1-Szenarien auf dev: Sitzung > 10 min ohne Reconnect (AK-22.3);
   Fan-out unter Last (AK-NF-10.3); Rejoin nach Drift (AK-18.4) — falls der
   Drift-Pfad nicht natürlich auslösbar ist, bleibt er unit-getestet
   (Log: „Renormalized drifted connectionCount", AK-18.3).
3. Log-Checks:
   - Access-Logs beider APIs vorhanden; im WS-Log prüfen, ob
     `$context.requestTime` ersetzt wird (Annahme aus umsetzungsbericht.md).
   - `aws logs describe-log-groups` → Retention 30 Tage (8 Handler),
     14 Tage (`scheduled-auto-reveal`) (AK-19.2).
   - Seit dem Deploy `AccessDenied` = 0 in den Lambda-Logs (AK-21.2).
4. Browser-Konsole auf dev: keine `round-history`-Fehler (BK-022-Prüfpunkt
   aus qa-ui-Bericht).

## Deployment DEV (automatisch bei Push auf development)

```bash
git push origin development
```

Workflow `deploy.yml`: test-Job (Lint, Build, Tests) → deploy-Job (CDK,
Health-Check, Frontend-Build mit env, SEO-Test, S3-Sync, CloudFront-
Invalidierung). Abschluss im GitHub-UI prüfen; anschließend dev-smoke:

```bash
npm run test:dev-smoke   # gegen https://dev.estimatenest.net (kein lokaler Server)
```

## Deployment PROD — NUR NACH EXPLIZITER FREIGABE DURCH DEN USER

> **STOP:** Push auf `main` veröffentlicht sofort auf estimatenest.net.
> Nicht ohne Freigabe des Users pushen.

```bash
git push origin main
```

prod baut mit `VITE_ROBOTS="index,follow"`, dev mit `noindex,nofollow`
(im deploy.yml hartkodiert je Umgebung). Vor einem prod-Push: dev-Deploy +
dev-smoke grün abwarten.

> **Lehre (2026-09-05, Prod-Sync PR #32):** Bei dev→main-Sync-PRs, deren
> Head der Trunk (development) selbst ist, **niemals**
> `gh pr merge --delete-branch` verwenden — das `--delete-branch` löschte
> `origin/development` (aus `5869a6d` wiederhergestellt, siehe status.md).

## Lokale Entwicklung & Verifikation

```bash
npm run dev              # frontend (:5173) + backend local-server (REST :3000, WS :3001)
npm run lint && npm run build && npm run test   # Quality-Gates
npm run test:e2e         # lokale Playwright-Suiten (smoke, scenarios) — seo/dev-smoke separat
npm run test:seo         # SEO gegen Prod-Preview-Build (:4173, Build vorher nötig)
npm run test:dev-smoke   # gegen deployed dev
```

> `test:e2e` ignoriert seit Commit `52e64d7` die seo-/dev-smoke-Specs
> (laufen über ihre eigenen Scripts gegen die richtigen Server).

## Rollback

- **Code:** `git revert` des fehlerhaften Commits auf `development` bzw.
  `main` → automatischer Deploy der alten Version. Hinweis seit Runde 1:
  die `LogRetention`-Ressourcen folgen dem Stack-Lebenszyklus; die
  Log-Gruppen selbst haben DeletionPolicy Retain (CloudFormation löscht sie
  auch bei Stack-Delete nicht) — nach einem Rollback also prüfen, ob
  Retention/Access-Logging noch dem gewünschten Stand entsprechen.
- **Infrastruktur:** CDK-Stack je env (`npm run destroy:dev|prod` nur nach
  Absprache); bei CloudFront-Problemen Invalidierung erneut auslösen
  (`aws cloudfront create-invalidation --paths "/*"`).

## Betrieb

- **logs:** CloudWatch Log Groups je Lambda-Handler (seit Runde 1 mit
  Retention 30/14 Tage statt „never expire"); strukturierte JSON-Logs,
  PII-redigiert (`backend/src/utils/logger.ts`). Zusätzlich API-GW-Access-Logs
  beider APIs (`/aws/apigateway/estimatenest-<env>-rest|-ws`, 30 Tage) mit
  requestId/status/Latenz/UserAgent — bei Verbindungsproblemen zuerst dort
  schauen; abgelehnte WS-Connects erscheinen als Warn-Log
  („WebSocket connect rejected: …") mit Gründen 400/404/429.
- **monitoring:** Health-Endpoint (`GET {api}/health`) im Deploy-Workflow
  geprüft. **Bewusste Entscheidung (2026-09-04, BK-008): keine
  CloudWatch-Alarme** — ephemere App ohne SLO-Zwang, der Health-Check im
  Deploy erkennt Deploy-Fehler, Funktionsfehler fängt die Testsuite +
  dev-smoke. Bei Bedarf später nachrüstbar (CDK), aktuell kein Aufwand.
- **daten:** DynamoDB-TTL räumt Räume nach 14 Tagen automatisch; keine
  manuelle Datenpflege.
- **kosten-check:** ~5–10 €/Monat (Pay-per-Use; PAY_PER_REQUEST, kein WAF) —
  entspricht architektur.md Abschnitt 7. **Ist-validiert am 2026-09-04
  (BK-009):** Cost Explorer zeigt Juni 26,68 USD (davon 16 USD WAF-Reste vor
  der Entfernung), Juli 7,58 USD, August 7,97 USD inkl. Tax — Schätzung
  bestätigt. **Quartalsweise Sichtprüfung** per `aws ce get-cost-and-usage`
  (read-only, ~2 min), Stand in architektur.md §7 pflegen.
- **wartung:** Dependabot aktiviert seit 2026-09-04 (BK-010, Commit 989e2ce):
  wöchentliche npm-/Actions-Updates über das Wurzel-Lockfile, minor-and-patch
  gruppiert. **Wichtig:** Dependabot-PRs zielen auf den Default-Branch (main)
  und Dependabot liest die Config vom Default-Branch — seit 2026-09-05 steht
  `target-branch: development` in der Config (Commit 877824f); bis der Sync
  auf main steht, gelten die PRs als dev-basiert (per gh pr edit umgestellt).
  Vor jedem Dependabot-Merge den Base-Branch prüfen
  (`gh pr view N --json baseRefName`). PRs nach dev-Verifikation
  (dev-smoke + test:e2e) mergen, nicht über Monate sammeln; Major-Upgrade-
  Runden wie gehabt mit PR-Review behandeln (Referenz: PR #18, uuid 11/ESLint
  10/Vitest 3/jsdom 28/Actions v6/v7). Major-Runde 2026-09-05 (#23–#31):
  react 19.2.8, react-router-dom 7, zustand 5, vite 8, vitest 5, express 5,
  jsdom 30, @types/node 26, body-parser 2 — gemerged auf `fbdad74`
  (development), dev verifiziert; dicebear entfernt statt gebumpt
  (ungenutzt); Sync auf prod erfolgt (PR #32 → main `5869a6d`, 2026-09-05).
  E2E vor größeren Frontend-Änderungen lokal + dev-smoke nach jedem
  dev-Deploy.
- **deploy/cache (BK-015, 2026-09-05):** CloudFront-Cache-Policies
  differenziert — `index.html` + SPA-Routen no-cache (nach jedem Deploy
  frisch vom Origin), `/assets/*` (gehashte Chunks) immutable 365 Tage,
  SPA-Fallback-Fehlerantworten 10 s (ErrorCachingMinTTL). Auslöser:
  Prod-Symptom „Failed to fetch dynamically imported module" — eine gecachte
  alte index.html referenzierte Chunks, die der S3-Sync des Folge-Deploys
  bereits gelöscht hatte (kein Server-Ausfall; API konsistent). Bei
  ähnlichen Symptomen zuerst Hard-Reload prüfen. Auf dev deployed +
  verifiziert (Cache-Header-Messung: index.html x-cache Miss/Miss,
  /assets Miss→Hit); **seit PR #33 auf prod deployed** (CI-Deploy
  #33976704657 grün; Verifikation: index.html 3× Miss, /assets GET
  Miss→Hit als text/javascript, SPA-Route 200 mit index.html —
  x-cache „Error" ist das normale Label umgeschriebener
  Fehlerantworten, jetzt nur 10 s gecacht).

## Checkliste vor Go-Live

Runde 1 „betriebs-haertung" (2026-09-29):

- [x] QA-Code-Bericht PASS (Lint 0, Build grün, 132 Backend- + 36 Frontend-Tests, Traceability vollständig; deploy-abhängige AKs markiert)
- [x] QA-UI-Bericht PASS (lokale E2E 9/9 grün, goldener Pfad Desktop + Mobile verifiziert; AK-22.3 deploy-abhängig)
- [x] 2 Pflicht-Review-Runden ohne verbleibende Findings
- [ ] **Freigabe des Users für den Push auf `development` (CI-Deploy dev)** — dann Verifikation laut Abschnitt „Runde 1" oben
- [ ] Prod-Sync (PR development → main) erst nach separater expliziter Freigabe, Merge ohne `--delete-branch`
- [x] Docs im Repo unter `docs/` auf Runde-1-Stand aktualisiert (requirements, architektur, go-live) — Kopie vom 2026-09-29, Commit folgt mit der Freigabe

Backfill-Bestätigung (2026-09-04, weiterhin gültig):

- [x] QA-Code-Bericht PASS (Lint 0, Vitest 144 grün, Traceability vollständig)
- [x] QA-UI-Bericht PASS (dev-smoke 3/3, lokale Suiten grün, manuelle Regressionstests, 0 Konsolenfehler)
- [x] prod- und dev-Umgebung live (estimatenest.net, dev.estimatenest.net)
- [x] CI/CD grün (Deploy-Workflow dev: zuletzt erfolgreich nach PR #18)
- [x] Freigabe des Users für den Live-Betrieb liegt vor (Projekt läuft seit Monaten)

## Hinweis: Artefakte im Repo

**Aktueller Stand (seit 2026-09-18, Repo-Commit `fac5d28`, löst BK-005 ab):**
Die finalen Artefakte liegen zusätzlich unter `docs/` im Projekt-Repo
(`requirements.md`, `architektur.md`, `go-live.md`); das
DevProzess-Artefakt-Repo (`~/WebstormProjects/devprozess/estimatenest/`)
führt die Historie und alle weiteren Berichte. Bei jedem Rundenabschluss
werden die `docs/`-Kopien auf den aktuellen Stand gebracht (Runde 1:
Kopie vom 2026-09-29, Commit zusammen mit der Freigabe).

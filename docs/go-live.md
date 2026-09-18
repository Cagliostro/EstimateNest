# Go-Live: EstimateNest

- datum: 2026-09-04 (Backfill-Dokumentation; Live-Betrieb läuft bereits)
- basis: architektur.md, qa-code-bericht.md (PASS), qa-ui-bericht.md (PASS)
- stand: prod main `2b2a95c` (2026-09-05) — **Prod-Sync PR #33**: BK-015
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
  `main` → automatischer Deploy der alten Version.
- **Infrastruktur:** CDK-Stack je env (`npm run destroy:dev|prod` nur nach
  Absprache); bei CloudFront-Problemen Invalidierung erneut auslösen
  (`aws cloudfront create-invalidation --paths "/*"`).

## Betrieb

- **logs:** CloudWatch Log Groups je Lambda-Handler; strukturierte JSON-Logs,
  PII-redigiert (`backend/src/utils/logger.ts`).
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

## Checkliste vor Go-Live (Backfill-Bestätigung)

- [x] QA-Code-Bericht PASS (Lint 0, Vitest 144 grün, Traceability vollständig)
- [x] QA-UI-Bericht PASS (dev-smoke 3/3, lokale Suiten grün, manuelle Regressionstests, 0 Konsolenfehler)
- [x] prod- und dev-Umgebung live (estimatenest.net, dev.estimatenest.net)
- [x] CI/CD grün (Deploy-Workflow dev: zuletzt erfolgreich nach PR #18)
- [x] Docs ins Repo kopiert — **bewusst nicht**: Entscheidung 2026-09-04 (BK-005), das DevProzess-Artefakt-Repo bleibt einzige Quelle (siehe Hinweis unten)
- [x] Freigabe des Users für den Live-Betrieb liegt vor (Projekt läuft seit Monaten)

## Hinweis: Artefakte im Repo

**Entschieden (2026-09-04, BK-005):** Die finalen Artefakte werden
**bewusst nicht** unter `docs/devprozess/` ins Projekt-Repo gespiegelt —
dieses DevProzess-Artefakt-Repo (`~/WebstormProjects/devprozess/estimatenest/`)
bleibt die einzige Quelle. Grund: keine Duplikation/Drift zwischen zwei
Quellen; das Ziel-Repo bleibt auf Code/Config beschränkt (Repo-Hygiene,
BK-006).

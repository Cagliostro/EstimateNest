# EstimateNest Architecture Review

**Date**: April 27, 2026
**Reviewer**: Architecture Assessment
**Version**: 3.1 (Updated)

---

## Executive Summary

EstimateNest is a real-time planning poker application using serverless AWS infrastructure (Lambda, DynamoDB, API Gateway, CloudFront) with a React frontend and WebSocket-based real-time communication. The architecture has solid foundations — clean monorepo structure, comprehensive CDK IaC, Zod validation, and TypeScript throughout. However, this review uncovered **5 critical, 11 high-priority, and 10+ medium-priority issues** spanning all layers.

**Key concerns (resolved in April 24–27 sessions):**

- ✅ **DynamoDB TTL is completely broken** — auto-expiry never works, leading to unbounded table growth → **FIXED**: `expiresAt` now uses epoch seconds throughout
- ✅ **SNS AlertTopic has no subscribers** — operational alarms fire into a void → **FIXED**: email subscription added
- ✅ **WebSocket connections leak** on page navigation/unmount — wastes server resources → **FIXED**: disconnect on unmount, null ws in onclose
- ✅ **Multiple race conditions** in join-room, vote, and WebSocket handlers → **FIXED**: atomic modifier claim, atomic connection counter, isModerator check
- ✅ **No ErrorBoundary wired** — React crashes produce white screen → **FIXED**: ErrorBoundary wraps App
- ✅ **Accessibility and UX debt** — 11 `alert()` calls, missing ARIA semantics → **FIXED**: replaced with `react-hot-toast`
- 🟡 **Utility scaffolding for P2** — centralized `dynamodb.ts` and `logger.ts` created (not yet wired into handlers)

---

## Priority Queue

---

### P0 — CRITICAL (Immediate Action)

#### 1. DynamoDB TTL Attribute Format Broken

**Severity**: CRITICAL
**Layer**: Backend + Infrastructure
**Files**: All handler files writing `expiresAt`; `estimateneest-stack.ts:54,64,75,92,111,128`

**Problem**:
DynamoDB TTL requires a **Unix epoch timestamp in seconds** (number type), but every handler writes `new Date().toISOString()` which produces ISO-8601 strings like `"2026-04-25T07:49:00.000Z"`. TTL will **never expire** items because the value format is invalid.

Affected tables: `RoomsTable`, `RoomCodesTable`, `ParticipantsTable`, `RoundsTable`, `VotesTable`.

Only `RateLimitTable` is correct — `vote.ts:83` correctly uses `Math.floor(Date.now() / 1000)`.

**Evidence**:

- `create-room.ts:78`: `expiresAt: new Date(Date.now() + getRoomTTL() * 1000).toISOString()`
- `join-room.ts:54`: same pattern
- `vote.ts:187`: same pattern in `getOrCreateActiveRound`
- All `UpdateCommand`s setting `expiresAt` use `.toISOString()`

**Impact**:

- Rooms never expire → indefinite storage, unbounded cost growth
- Room codes never expire → short code namespace never reclaimed
- Participants never expire → orphaned records accumulate
- Rounds/votes never expire → table grows linearly with usage

**Fix**:
Replace `.toISOString()` with `Math.floor(Date.now() / 1000) + TTL_SECONDS` in all handler files that write `expiresAt`.

**Status**: ✅ FIXED — `expiresAt` now uses epoch seconds in `create-room.ts`, `join-room.ts`, `round-history.ts`, `local-server.ts`, and `packages/shared/src/index.ts` (Room type + `isRoomExpired`). Backward-compatible read-side handling for old ISO-8601 data.

---

#### 2. SNS AlertTopic Has No Subscribers

**Severity**: CRITICAL
**Layer**: Infrastructure
**File**: `estimateneest-stack.ts:929-931`

**Problem**:
The `AlertTopic` SNS topic is created with a display name, and all CloudWatch alarms are configured with `addAlarmAction` and `addOkAction` pointing to it. But **no subscription** is added — no email, no HTTP endpoint, no Lambda target.

**Evidence**:

```typescript
const alertTopic = new sns.Topic(this, 'AlertTopic', {
  displayName: `EstimateNest-${envName}-${colorSuffix}-Alerts`,
});
// No .addSubscription() call anywhere in the stack
```

**Impact**:
All monitoring and alerting infrastructure is **completely silent**. Errors, throttles, disconnects, and WAF blocks happen without any notification.

**Fix**:
Add email subscription or Slack integration:

```typescript
alertTopic.addSubscription(new subs.EmailSubscription('alerts@example.com'));
```

**Status**: ✅ FIXED — Added `subscriptions.EmailSubscription('sebastian.roekens@googlemail.com')` to the `AlertTopic`.

---

#### 3. WebSocket Connections Leak on Unmount / Navigation

**Severity**: CRITICAL
**Layer**: Frontend
**Files**: `hooks/use-room-connection.ts`, `lib/websocket-client.ts`

**Problem**:
When `RoomPage` unmounts (user navigates to Home, clicks browser back, etc.), the cleanup effects remove message handlers and stop polling, but **never call `service.disconnect()`**. The `WebSocketService` singleton still holds the `WebSocketClient` instance with an open connection.

Additionally, `websocket-client.ts:239-258` — the reconnection `setTimeout` is only cleared in `disconnect()`, not on the `onclose` handler. If the component unmounts before reconnect fires:

1. New orphan WebSocket is created
2. No handlers registered, no one listens
3. On its own close, `attemptReconnect()` fires again → infinite loop

**Evidence**:

- `use-room-connection.ts:436-442`: removes handlers, stops polling — no disconnect
- `use-room-connection.ts:477-481`: removes state callback — no disconnect
- `websocket-client.ts:180`: `this.ws = null` only in `disconnect()`, not `onclose`

**Impact**:

- Server-side: stale `connectionId` entries in participants table, extra `PostToConnection` failures
- Client-side: zombie reconnect loops, memory leaks

**Fix**:

1. Add `service.disconnect()` to the unmount cleanup in `use-room-connection.ts`
2. In `websocket-client.ts`, add `this.ws = null` in `onclose` handler
3. Clear reconnect timer both in `onclose` handler and in `disconnect()`

**Status**: ✅ FIXED — `this.ws = null` and reconnect timer cleanup added to `onclose`; `service.disconnect()` added to unmount cleanup in `use-room-connection.ts`.

---

#### 4. ErrorBoundary Exists but Is Never Used

**Severity**: CRITICAL
**Layer**: Frontend
**Files**: `components/ErrorBoundary.tsx`, `main.tsx:7-13`

**Problem**:
A class-based `ErrorBoundary` component exists but is **never imported or rendered** in `main.tsx`. If any component throws during rendering, React unmounts the entire tree, producing a white screen with no user feedback.

**Evidence**:

- `components/ErrorBoundary.tsx`: fully implemented with `componentDidCatch`, fallback UI, and retry button
- `main.tsx`: no reference to `ErrorBoundary` — `<App />` is rendered directly

**Impact**:
Any unhandled render error or thrown exception in a hook or component causes a **catastrophic white screen** with no recovery path for the user.

**Fix**:
In `main.tsx`, wrap `<App />` with `<ErrorBoundary>`:

```tsx
root.render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
```

**Status**: ✅ FIXED — ErrorBoundary imported and wraps `<App />` in `main.tsx`.

---

#### 5. No Point-in-Time Recovery on DynamoDB Tables

**Severity**: CRITICAL
**Layer**: Infrastructure
**File**: `estimateneest-stack.ts:46-129`

**Problem**:
None of the 6 DynamoDB tables have `pointInTimeRecovery: true`. If data is accidentally deleted or corrupted, there is no way to restore to a previous point in time (up to the last 35 days).

**Evidence**:
No `.pointInTimeRecovery(true)` or `pointInTimeRecovery: true` on any table definition.

**Impact**:
Accidental `DeleteItem`, overwritten data, or buggy handler code could cause permanent data loss with no recovery path.

**Fix**:
Add `pointInTimeRecovery: true` to all production tables (costs ~$0.20/GB/month additional storage).

---

### P1 — HIGH PRIORITY (Next Sprint)

#### 6. Short Code Collision (No ConditionExpression)

**Severity**: HIGH
**Layer**: Backend
**File**: `create-room.ts:125-135`

**Problem**:
`PutCommand` to `ROOM_CODES_TABLE` has no `ConditionExpression`. With 6-character codes from a 29-character alphabet (~738M combinations), two rooms created simultaneously could get the same short code. The second `PutCommand` **silently overwrites** the first.

**Impact**:
The first room's short code becomes invalid. Users trying to join the first room via its short code will be directed to the second room. Data corruption.

**Fix**:
Add `ConditionExpression: 'attribute_not_exists(shortCode)'` to the `PutCommand`. On `ConditionalCheckFailedException`, retry with a new code (up to N attempts).

**Status**: ✅ FIXED — `create-room.ts` now has `ConditionExpression` on `ROOM_CODES_TABLE` PutCommand with a 5-attempt retry loop generating new codes on collision.

---

#### 7. Password Bypass via participantId

**Severity**: HIGH
**Layer**: Backend
**File**: `join-room.ts:138-146`

**Problem**:
When `participantId` is provided AND the room has a moderator password, the handler checks if the participant record exists in DynamoDB. If it does, `passwordValid` is set to `true` **without verifying the provided password**.

This means anyone who knows a valid `participantId` (which is a UUID) can bypass the password and join as a moderator.

**Impact**:
Unauthorized moderator access. A leaked `participantId` (visible in WebSocket messages, stored in localStorage) bypasses password protection entirely.

**Fix**:
Always require password verification when the room has a password, regardless of whether `participantId` is provided. Only skip password check if the stored participant record already has an active WebSocket connection (reconnection scenario).

**Status**: ⏸️ DEFERRED — Per architecture decision: OK to require password on reconnect without active WebSocket. Acceptable behavior for current usage patterns.

---

#### 8. No Moderator Check on `newRound` (vote handler)

**Severity**: HIGH
**Layer**: Backend
**File**: `vote.ts:998-1158`

**Problem**:
The `handleNewRound` WebSocket handler has **no `isModerator` check**. Any participant can:

- Create a new round
- Mark all existing unrevealed rounds as revealed (iterating and updating each one)

**Impact**:
Any participant can disrupt the voting process by creating rogue rounds or prematurely revealing unrevealed rounds. This is a functional authorization bypass.

**Fix**:
Add an `isModerator` check at the beginning of `handleNewRound`, consistent with `handleReveal` (which does check).

**Status**: ✅ FIXED — Added `if (!participant.isModerator) { throw new Error('Only moderators can start a new round'); }` in `vote.ts:handleNewRound`.

---

#### 9. Moderator Race Condition on Join

**Severity**: HIGH
**Layer**: Backend
**File**: `join-room.ts:247,268`

**Problem**:
When two participants join a room simultaneously with no existing participants, both check `existingParticipants.length === 0` before either creates their participant record. Both see the room as empty and both set `isModerator: true`.

**Impact**:
Two moderators in a room when only one is expected. The first moderator has no way to remove the second.

**Fix**:
Use a conditional write (`ConditionExpression: 'attribute_not_exists(participantId)'`) combined with a dedicated "first participant" claim. Or use the room's `moderatorPassword` field: if a password is set, only the participant who provides it becomes moderator; if no password, the first to successfully write wins.

**Status**: ✅ FIXED — Added `moderatorAssigned` field to Room type. Atomic claim via `UpdateCommand` with `ConditionExpression: 'attribute_not_exists(moderatorAssigned) OR moderatorAssigned = :false'` in both new-participant code paths in `join-room.ts`.

---

#### 10. WebSocket Connection Limit Race Condition

**Severity**: HIGH
**Layer**: Backend
**File**: `websocket-connect.ts:62-98`

**Problem**:
The max-participants check queries `PARTICIPANTS_TABLE` for a count of connections, then compares to `room.maxParticipants || 50`. Two simultaneous WebSocket connects for the same room can both read `Count < maxParticipants` and both proceed to update, exceeding the limit.

**Impact**:
Room can exceed its configured participant limit. For rooms with `maxParticipants: 50`, this could theoretically allow 100 participants.

**Fix**:
Use a conditional write (`ConditionExpression: 'size(connectionIds) < :max'`) or use DynamoDB transactions with a count item. Alternatively, accept the race as low-risk and simply enforce strictly on the write with a condition.

**Status**: ✅ FIXED — Added `connectionCount` field to Room type. `websocket-connect.ts` uses atomic `ADD connectionCount :inc` with `ConditionExpression: 'connectionCount < :max OR attribute_not_exists(connectionCount)'`. `websocket-disconnect.ts` decrements: `ADD connectionCount :dec`.

---

#### 11. No Pagination on DynamoDB Queries

**Severity**: HIGH
**Layer**: Backend
**Files**: `round-history.ts:52-63`, `vote.ts:445-454`, `websocket-disconnect.ts:18-28`, and others

**Problem**:
Multiple `QueryCommand` calls do not check for `LastEvaluatedKey`. DynamoDB returns at most 1MB of data per query. If results exceed this, data is **silently truncated**.

**Evidence**:

- `round-history.ts:52-63`: Query on Rounds table with no limit
- `vote.ts:445-454`: Query on Votes table (mitigated by narrow roundId+roomId scope)
- `websocket-disconnect.ts:18-28`: Query on participants by connectionId (usually 1 result)

**Impact**:
Round history returns incomplete results for rooms with many rounds. Vote queries could miss votes in high-traffic rooms.

**Fix**:
Implement pagination loops with `LastEvaluatedKey` handling for all unbounded queries. Set appropriate `Limit` values.

---

#### 12. Route Conflict `/legal` vs `/:roomCode`

**Severity**: HIGH
**Layer**: Frontend
**File**: `App.tsx`

**Problem**:
React Router routes are defined in this order:

```
/           → HomePage
/:roomCode  → RoomPage
/legal      → LegalPage
/legal` correctly matches the `/legal` route, but a room with the short code "legal" would match `/legal` and could never be reached as a room. Short codes are 6-character alphanumeric (uppercase hex-like), so the probability is extremely low but theoretically possible.

**Impact**:
If the short code generator ever produces "legal", that room becomes unreachable via URL.

**Fix**:
Either:
1. Add `"legal"` to the ambiguous character list excluded from short codes
2. Restructure routes: `/room/:roomCode` instead of `/:roomCode`
3. Add a check in `RoomPage` to distinguish room codes from static paths

**Status**: ✅ FIXED — Added `BLOCKED_CODES = new Set(['LEGAL'])` in `generateShortCode()`. On match, the function recursively regenerates.

---

#### 13. 11x `alert()` Calls — Inaccessible UX

**Severity**: HIGH
**Layer**: Frontend
**Files**: `HomePage.tsx`, `RoomPage.tsx`

**Problem**:
The codebase uses `alert()` dialogs in 11 locations for user feedback. `alert()` is:
- Blocking (prevents all interaction until dismissed)
- Not customizable (no styling, no auto-dismiss)
- Poorly supported by screen readers
- Unpleasant UX

**Evidence**:
- `HomePage.tsx:73,79,133`: general errors
- `RoomPage.tsx:82,96,107,181,193,219,236`: various join/vote/leave errors

**Impact**:
Poor user experience, accessibility violations (WCAG 2.1.1), and no way to show non-blocking feedback.

**Fix**:
Replace with a proper toast/notification system (e.g., `react-hot-toast`) or inline error messages.

**Status**: ✅ FIXED — Installed `react-hot-toast`, replaced all 11 `alert()` calls with `toast.success()`/`toast.error()`, added `<Toaster position="bottom-right" />` in `main.tsx`.

---

#### 14. Room-to-Room Navigation Stale State

**Severity**: HIGH
**Layer**: Frontend
**File**: `RoomPage.tsx:113-138`

**Problem**:
When a user navigates from `/ROOM1` to `/ROOM2` in the browser URL bar (or via a link), `RoomPage` does NOT unmount/remount — it re-renders with a new `roomCode` param. The auto-join guard checks `connectionState === 'disconnected' && !roomId`, but both conditions are false (still connected to ROOM1). The user stays connected to ROOM1 while viewing ROOM2's data (or lack thereof).

**Impact**:
User sees participants, rounds, and votes from ROOM1 while the URL shows ROOM2. Creates confusion and data leak (participants of ROOM1 are visible to someone in ROOM2).

**Fix**:
Add a `useEffect` that watches `roomCode` and calls `disconnect()` + `joinRoom()` when it changes.

**Status**: ✅ FIXED — Added `prevRoomCodeRef` useEffect in `RoomPage.tsx` that detects room code changes and resets all stores (`clearRoom`, `clearParticipant`, `setDisconnected`).

---

#### 15. CloudFront WAF Only in us-east-1

**Severity**: HIGH
**Layer**: Infrastructure
**File**: `estimateneest-stack.ts:1275`

**Problem**:
The global (CloudFront) WAF ACL is only created when `this.region === 'us-east-1'`. CloudFront WAF ACLs must be created in `us-east-1`, but if the stack deploys to any other region, the CloudFront distribution has **no WAF protection**.

**Impact**:
CloudFront distributes content without WAF filtering — no OWASP rules, no rate limiting at the CDN edge.

**Fix**:
The infrastructure must always deploy the CloudFront WAF ACL to `us-east-1` regardless of the main deployment region. Options:
1. Use a separate stack in us-east-1 for the CloudFront WAF
2. Require the main stack to deploy to us-east-1 when `isProduction`

---

#### 16. CORS Wildcard Origin

**Severity**: HIGH
**Layer**: Infrastructure
**File**: `estimateneest-stack.ts:651`

**Problem**:
CORS is configured as `Cors.ALL_ORIGINS` with a TODO comment: `// TODO: Revert to stricter CORS after debugging`.

**Impact**:
Any domain can make requests to the API. While this is acceptable for a public API without cookies/credentials, it increases the attack surface — an XSS on any site could potentially use the API key (visible in client-side code) to interact with the API.

**Fix**:
Restrict to known frontend origins (e.g., `https://estimatenest.net`, `https://dev.estimatenest.net`).

---

### P2 — MEDIUM PRIORITY (Within 2-3 Sprints)

| # | Finding | Layer | File | Issue | Status |
|---|---------|-------|------|-------|--------|
| 17 | Scheduled auto-reveal uses `ScanCommand` | Backend | `scheduled-auto-reveal.ts:134-145` | `Scan` on Rounds table doesn't scale. Filter `isRevealed=false` over scanned data. Also no `ConditionExpression` on reveal `UpdateCommand` (line 156-166), allowing double-reveal. | ❌ OPEN |
| 18 | `handleNewRound` partial failure risk | Backend | `vote.ts:1026-1097` | Marks all unrevealed rounds as revealed by iterating and updating each. No transaction — failure mid-loop leaves inconsistent state. | ❌ OPEN |
| 19 | Moderator reassignment race | Backend | `websocket-disconnect.ts:56-108` | Two moderators disconnecting simultaneously race on reading participant list and assigning new moderator. | ❌ OPEN |
| 20 | Excessive logging with PII | Backend | `vote.ts:415-427` | `console.log` dumps full participant lists with names, connectionIds, and vote values. CloudWatch cost + PII exposure. | ❌ OPEN |
| 21 | API Gateway usage plan 10K req/month | Infra | `estimateneest-stack.ts:742` | ~333 requests/day. At 100 req/min allowance, quota hit in under 2 hours at sustained traffic. Way too low for production. | ⏸️ DEFERRED (keep as-is) |
| 22 | No request correlation ID | Backend | All handlers | Log entries lack trace/request ID. Hard to correlate log lines across Lambda invocations without structured logging. | 🟡 PARTIAL — `logger.ts` utility created but not wired into handlers |
| 23 | WebSocket singleton holds stale state | Frontend | `websocket-service.ts:22` | `WebSocketService` singleton persists across room changes. May hold references to stale room/participant data. | ❌ OPEN (`disconnect()` doesn't clear `messageHandlers`) |
| 24 | HTTP polling never stops | Frontend | `use-room-connection.ts:284` | 5-second HTTP polling runs alongside healthy WebSocket indefinitely. Unnecessary network traffic. | ❌ OPEN |
| 25 | "View all history" button dead | Frontend | `RoomPage.tsx:990` | Clickable `<button>` element with no `onClick` handler. Incomplete feature or should be non-interactive. | ❌ OPEN |
| 26 | Password dialog lacks ARIA modal | Frontend | `HomePage.tsx:390-440` | No `role="dialog"`, `aria-modal`, focus trap, or Escape key handler. Violates WCAG. | ❌ OPEN |
| 27 | Broadcast/cache create own DynamoDB clients | Backend | `broadcast.ts:12-13`, `cache.ts:197` | Separate client instances bypass X-Ray tracing. Connection pools duplicated. | 🟡 PARTIAL — `dynamodb.ts` utility created but not wired into handlers |

---

### P3 — LOW PRIORITY / TECH DEBT (Backlog)

| # | Finding | Layer | File | Details |
|---|---------|-------|------|---------|
| 28 | Invalid JSON body returns 500 | Backend | `create-room.ts:35` | Should return 400. |
| 29 | In-memory cache unbounded | Backend | `cache.ts` | Maps grow unlimited on long-running Lambda. No eviction beyond TTL. |
| 30 | No TTL on orphaned records | Backend | Participants/Votes tables | Parent rows cleaned up by Room TTL, but associated participant/vote records orphaned. |
| 31 | Auto-reveal re-throws causing retries | Backend | `scheduled-auto-reveal.ts:214` | Async Lambda retry (2 retries). Could cause duplicate reveals. |
| 32 | `DeploymentTimestamp` tag churn | Infra | `app.ts:36` | Tag changes every deploy, causing CloudFormation drift detection noise. |
| 33 | Dev/prod share ACM certs | Infra | `cdk.json:11-20` | Same certificate ARN for dev and prod. Cert rotation/expiry affects both. |
| 34 | Lambda alarm IDs use numeric indices | Infra | `estimateneest-stack.ts:959` | Reordering functions changes logical IDs, risking resource replacement. |
| 35 | CreateRoom fallback `example.com` | Infra | `estimateneest-stack.ts:179` | If `domainName` undefined, join URLs use `example.com`. |
| 36 | Dead code: `addVote`, `clearError` | Frontend | `store/room-store.ts:48`, `store/connection-store.ts:29` | Methods defined but never called anywhere. |
| 37 | Dead deps: `@dicebear/*` | Frontend | `package.json` | DiceBear (~60KB) imported but Avatar uses custom initials. Not used anywhere. |
| 38 | Unused CSS classes | Frontend | `index.css:37-54` | `.rhythm-1` through `.rhythm-6` never referenced in any TSX. |
| 39 | Invalid Tailwind class | Frontend | `RoomPage.tsx:208,285` | `gray-750` not in custom palette (only 50-900 defined). No effect. |
| 40 | Duplicated SVG icon paths | Frontend | Multiple | Edit icon (pencil) and chevron SVG paths duplicated across files. Extract to shared component. |
| 41 | RoomPage.tsx is 994 lines | Frontend | `RoomPage.tsx` | Needs extraction of voting panel, participant list, room controls, and round history into separate components. |

---

## Architectural Strengths to Preserve

1. **Clean monorepo structure** — npm workspaces with clear dependency order (shared → backend → frontend → infrastructure)
2. **TypeScript throughout** — end-to-end type safety from shared Zod schemas to handler code to frontend
3. **Comprehensive CDK IaC** — full AWS infrastructure defined as code with blue-green deployment support
4. **Real-time WebSocket with polling fallback** — resilient connectivity with graceful degradation
5. **Zod validation on all API endpoints** — runtime type safety separates validation from business logic
6. **Rate limiting** — DynamoDB-backed per-connection, per-message-type rate limiting
7. **Idempotent voting** — SHA256-based idempotency key prevents duplicate vote recording
8. **Cache invalidation on mutation** — every write operation invalidates relevant in-memory caches
9. **Optimistic locking for active rounds** — conditional writes prevent duplicate round creation
10. **Granular IAM permissions** — least-privilege per-table, per-operation IAM policies
11. **Password security** — scrypt with random salt + timing-safe comparison
12. **Stale connection cleanup** — `PostToConnection` failures (410/403) remove stale `connectionId` from participant records

---

## Risk Matrix

| Risk | Probability | Impact | Mitigation | Priority |
|------|------------|--------|------------|----------|
| DynamoDB TTL broken → cost overrun, infinite storage | Certain | High | Fix all handlers to write epoch seconds, not ISO strings | P0 #1 |
| Alarms silent → operational blindness | Certain | High | Add SNS subscriptions (email/Slack/PagerDuty) | P0 #2 |
| WebSocket leaks → resource exhaustion | High | Medium | Add disconnect on unmount, fix reconnect timer | P0 #3 |
| White screen crash → total app failure | Medium | High | Wire ErrorBoundary in main.tsx | P0 #4 |
| No PITR → permanent data loss | Low | Critical | Enable point-in-time recovery on all tables | P0 #5 |
| Short code collision → data corruption | Low | High | Add ConditionExpression to PutCommand | P1 #6 |
| Password bypass → unauthorized access | Medium | High | Always verify password when room has one | P1 #7 |
| Unauthorized round creation → disruption | Medium | High | Add isModerator check to handleNewRound | P1 #8 |
| Moderator race → duplicate moderators | Medium | Medium | Use conditional write for first-participant claim | P1 #9 |
| Connection limit exceeded | Low | Medium | Use conditional write for connection tracking | P1 #10 |
| Query data truncation | Low | Medium | Implement LastEvaluatedKey pagination | P1 #11 |
| alert() usage → accessibility violation | High | Medium | Replace with toast/notification system | P1 #13 |
| Room navigation stale state → data leak | Medium | High | Add roomCode change detection | P1 #14 |
| CORS wildcard → XSS amplification | Low | Medium | Restrict to known frontend origins | P1 #16 |

---

## Success Metrics (Targets)

| Metric | Current | Target | Measurement |
|--------|---------|--------|-------------|
| P99 Latency (vote) | ~500ms | <200ms | CloudWatch Metrics |
| Error Rate | Unknown | <0.1% | Lambda error logs |
| Test Coverage | ~74% | >70% (maintained) | Vitest coverage |
| Bundle Size | 54kb main | <150kb | Vite bundle analyzer |
| Deployment Time | ~5min | <2min | GitHub Actions |
| Monthly Cost | ~$50 | <$35 | AWS Cost Explorer |
| Accessibility Violations | 11 alert() + ARIA gaps | 0 critical | aXe/lighthouse |
| DynamoDB Ops/vote | ~8 | <8 | CloudWatch Metrics |
| WebSocket Connections | No enforced limit | 100/room | API Gateway Metrics |

---

## Fix Status Summary

| # | Finding | Priority | Status |
|---|---------|----------|--------|
| 1 | DynamoDB TTL Attribute Format Broken | P0 | ✅ FIXED |
| 2 | SNS AlertTopic Has No Subscribers | P0 | ✅ FIXED |
| 3 | WebSocket Connections Leak on Unmount | P0 | ✅ FIXED |
| 4 | ErrorBoundary Exists but Is Never Used | P0 | ✅ FIXED |
| 5 | No Point-in-Time Recovery | P0 | ⏸️ DEFERRED (data is ephemeral) |
| 6 | Short Code Collision (No ConditionExpression) | P1 | ✅ FIXED |
| 7 | Password Bypass via participantId | P1 | ⏸️ DEFERRED (acceptable behavior) |
| 8 | No Moderator Check on newRound | P1 | ✅ FIXED |
| 9 | Moderator Race Condition on Join | P1 | ✅ FIXED |
| 10 | WebSocket Connection Limit Race | P1 | ✅ FIXED |
| 11 | No Pagination on DynamoDB Queries | P1 | ⏸️ DEFERRED (not needed at current scale) |
| 12 | Route Conflict /legal vs /:roomCode | P1 | ✅ FIXED |
| 13 | 11x alert() Calls | P1 | ✅ FIXED |
| 14 | Room-to-Room Navigation Stale State | P1 | ✅ FIXED |
| 15 | CloudFront WAF Only in us-east-1 | P1 | ⏸️ DEFERRED (current behavior fine) |
| 16 | CORS Wildcard Origin | P1 | ⏸️ DEFERRED (keep as-is) |
| 17 | Scheduled auto-reveal uses ScanCommand | P2 | ❌ OPEN |
| 18 | handleNewRound partial failure risk | P2 | ❌ OPEN |
| 19 | Moderator reassignment race | P2 | ❌ OPEN |
| 20 | Excessive logging with PII | P2 | ❌ OPEN |
| 21 | API Gateway usage plan 10K req/month | P2 | ⏸️ DEFERRED |
| 22 | No request correlation ID | P2 | 🟡 PARTIAL (logger.ts exists, not wired) |
| 23 | WebSocket singleton holds stale state | P2 | ❌ OPEN |
| 24 | HTTP polling never stops | P2 | ❌ OPEN |
| 25 | "View all history" button dead | P2 | ❌ OPEN |
| 26 | Password dialog lacks ARIA modal | P2 | ❌ OPEN |
| 27 | Broadcast/cache create own DynamoDB clients | P2 | 🟡 PARTIAL (dynamodb.ts exists, not wired) |

## Remaining Work

| # | Finding | Priority |
|---|---------|----------|
| 5 | No Point-in-Time Recovery | P0 deferred |
| 11 | No Pagination on DynamoDB Queries | P1 deferred |
| 15 | CloudFront WAF Only in us-east-1 | P1 deferred |
| 16 | CORS Wildcard Origin | P1 deferred |
| 17 | Scheduled auto-reveal uses ScanCommand | P2 |
| 18 | handleNewRound partial failure risk | P2 |
| 19 | Moderator reassignment race | P2 |
| 20 | Excessive logging with PII | P2 |
| 21 | API Gateway usage plan 10K req/month | P2 deferred |
| 22 | No request correlation ID | P2 (partial) |
| 23 | WebSocket singleton holds stale state | P2 |
| 24 | HTTP polling never stops | P2 |
| 25 | "View all history" button dead | P2 |
| 26 | Password dialog lacks ARIA modal | P2 |
| 27 | Broadcast/cache create own DynamoDB clients | P2 (partial) |
| 28-41 | P3 items | Various (in backlog) |
```

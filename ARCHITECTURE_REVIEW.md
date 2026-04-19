# EstimateNest Architectural Review & Optimization Roadmap

**Date**: April 18, 2026  
**Reviewer**: Architectural Assessment  
**Version**: 2.0 (Updated Post-Bug Fix Analysis)

## Executive Summary

EstimateNest has solid architectural foundations with clean separation of concerns, comprehensive CDK infrastructure, and real-time WebSocket communication. **Recent voting synchronization bug fixes** have addressed critical round management issues, but significant gaps remain in **security**, **performance**, and **production readiness**.

**Key Changes Since Last Review:**

- ✅ **Voting synchronization bug fixed** - Round ID mismatches and vote contamination resolved
- ✅ **WebSocket message formatting standardized** - Fixed "undefined message type" console logs
- ✅ **Input validation implemented** - Zod schemas in place for all handlers
- ✅ **Enhanced monitoring complete** - CloudWatch dashboards, X-Ray tracing, SNS alerting
- ✅ **Rate limiting complete** - API keys enforced, WebSocket connection/message limits, WAF protection
- ⚠️ **Performance optimizations in progress** - DynamoDB query optimizations implemented, caching implemented

## Progress Dashboard

| Area              | Status     | Progress | Notes                                                                                |
| ----------------- | ---------- | -------- | ------------------------------------------------------------------------------------ |
| **Security**      | ✅ Good    | 85%      | Validation ✅, IAM ✅, Rate Limiting ✅                                              |
| **Observability** | ✅ Good    | 75%      | Alarms ✅, Dashboards ✅, Tracing ✅                                                 |
| **Testing**       | ⚠️ Partial | 50%      | 23 integration tests ✅, WebSocket tests added, error scenarios covered, Coverage ❌ |
| **Performance**   | ⚠️ Partial | 80%      | Query optimizations complete, caching implemented                                    |
| **Frontend**      | ⚠️ Partial | 60%      | Memory leak risks reduced, hook optimization implemented                             |

## Priority Queue

### P0 - CRITICAL (Immediate Action - Week 1-2)

#### [✅] 1. Rate Limiting Completion

**Risk**: High (DoS, resource exhaustion)  
**Evidence**: ✅ API keys enforced; ✅ WebSocket connection limits (100/room); ✅ Message throttling (20/sec); ✅ WAF with OWASP rules; ✅ API Gateway throttling for WebSocket  
**Impact**: Single user can flood system, exhausting DynamoDB RCU/WCU

**Tasks:**

- [x] **Add API key requirement** to REST API usage plan (`infrastructure/src/estimateneest-stack.ts:433`)
- [x] **Implement WebSocket connection limits** (max 100 connections per room)
- [x] **Add WebSocket message throttling** (20 messages/sec per connection)
- [x] **Deploy AWS WAF** with OWASP Core Rule Set + rate-based rules (100 req/5min per IP) for REST API; WebSocket protected via API Gateway throttling (20 burst, 5 steady-state)
- _Owner: Infrastructure Team | Est: 3 days_

#### [✅] 2. Monitoring Enhancement

**Risk**: High (Blind operations)  
**Evidence**: ✅ CloudWatch dashboards; ✅ X-Ray tracing; ✅ SNS alerting  
**Impact**: Limited visibility into outages, performance degradation, or abuse

**Tasks:**

- [x] **Create CloudWatch dashboards** for Lambda errors, DynamoDB throttling, WebSocket metrics
- [x] **Add AWS X-Ray distributed tracing** for Lambda → WebSocket → DynamoDB flows
- [x] **Set up Slack/email alerting** for critical alarms (>1% error rate, >20 disconnects/5min)
- [ ] **Add custom metrics** for WebSocket message rates, room creation/voting patterns (deferred to P1)
- _Owner: DevOps Team | Est: 5 days_

#### [✅] 3. IAM Permission Refinement

**Risk**: Medium-High (Privilege escalation)  
**Evidence**: ✅ Granular IAM policies applied to `join-room.ts` and `vote.ts`; ✅ Principle of least privilege enforced  
**Impact**: Lambda compromise could lead to broader data access than necessary

**Tasks:**

- [x] **Replace `grantReadWriteData` with granular grants** for `join-room.ts`:
  - `participantsTable.grant(joinRoomHandler, 'dynamodb:PutItem', 'dynamodb:UpdateItem')`
- [x] **Audit `vote.ts` permissions** - create custom policy with exact actions needed
- [x] **Verify no handler needs `DeleteItem` permissions**
- [x] **Security audit report** showing reduced attack surface
- _Owner: Security Team | Est: 2 days_

---

### P1 - HIGH PRIORITY (Next Sprint - Week 3-4)

#### [⚠️] 4. DynamoDB Query Optimization

**Evidence**: `join-room.ts` makes 5 queries; `vote.ts` up to 16 operations; N+1 pattern in `round-history.ts`  
**Impact**: Increased latency (~100-200ms), higher DynamoDB costs, poor scalability

**Tasks:**

- [ ] **Add Composite GSI** on `ROUNDS_TABLE`: `(roomId, isRevealed)` with `startedAt` sort key
- [x] **Add GSI on `VOTES_TABLE`**: `(roomId, roundId)` for efficient vote queries (✅ deployed)
- [ ] **Optimize `join-room.ts`**: Use `GetCommand` for participant lookup when ID provided (5→3 queries)
- [x] **Fix N+1 in `round-history.ts`**: Implement parallel query pattern for votes (✅ deployed)
- [x] **Add caching layers**: Participant list cache (3s TTL) + active round cache (2s TTL) + room cache (10s TTL) (✅ implemented)
- [x] **Reduce vote polling loop** from 8 to 4 attempts with 1s max delay (✅ deployed)
- _Owner: Backend Team | Est: 7 days_
- **Expected Improvement**: 40-50% reduction in DynamoDB operations

#### [⚠️] 5. Frontend Memory Leak & Performance Fixes

**Evidence**: `use-room-connection.ts` hook recreation + interval cleanup issues; complex countdown logic  
**Impact**: Memory bloat over time, zombie intervals, poor user experience

**Tasks:**

- [x] **Implement custom interval hooks**: `useInterval`/`useTimeout` with guaranteed cleanup
- [x] **Simplify countdown logic** - move to Zustand store to avoid dependency chains (94→40 lines)
- [ ] **Remove `hookId` from dependency arrays** - use empty `[]` for stable callbacks
- [ ] **Add cleanup for all timeouts** - ensure every `setTimeout` has corresponding `clearTimeout`
- [ ] **Implement exponential backoff** for polling errors
- _Owner: Frontend Team | Est: 5 days_

#### [⚠️] 6. Critical Path Testing

**Evidence**: 3 integration tests added; missing WebSocket, error scenario, and concurrent voting tests  
**Impact**: Regression risk, especially for voting/round logic and synchronization

**Tasks:**

- [ ] **WebSocket integration tests** - mock API Gateway for connection lifecycle
- [ ] **Concurrent voting tests** - race condition validation with multiple participants
- [ ] **Error scenario tests** - 404/403/500 responses, validation failures
- [ ] **Frontend hook tests** - `use-room-connection.ts` edge cases
- [ ] **Load testing** - k6 for WebSocket concurrency (100+ connections)
- _Owner: QA/Test Team | Est: 6 days_
- **Target**: Increase test coverage from <5% to >70%

---

### P2 - MEDIUM PRIORITY (Within 2-3 Sprints - Week 5-7)

#### [❌] 7. Frontend Bundle Optimization

**Evidence**: Single bundle (215kb gzipped); no lazy loading  
**Impact**: Slow initial load (~3-4s on 3G), poor Core Web Vitals

**Tasks:**

- [ ] **Route-based code splitting** (`React.lazy` + `Suspense`)
- [ ] **Dynamic import** for legal page, room components
- [ ] **Bundle analyzer plugin** for Vite
- [ ] **Target bundle size**: <150kb gzipped
- _Owner: Frontend Team | Est: 4 days_

#### [❌] 8. CloudFront WAF/DDoS Protection

**Evidence**: CloudFront distributions lack AWS WAF integration; REST API has regional WAF with OWASP rules  
**Risk**: Application-layer attacks (SQL injection, XSS via WebSocket)

**Tasks:**

- [ ] **WAF with OWASP Core Rule Set**
- [ ] **Rate-based rules** (100 requests/5min per IP)
- [ ] **Geographic blocking** (optional)
- _Owner: Infrastructure Team | Est: 3 days_

#### [❌] 9. Deployment Reliability

**Evidence**: `deploy.yml` has no rollback strategy; frontend build depends on infra outputs  
**Risk**: Broken deployment → extended downtime

**Tasks:**

- [ ] **Blue-green deployments** with Route 53 weighted routing
- [ ] **Health checks** - Lambda function validation before traffic shift
- [ ] **Rollback automation** - CloudFormation stack rollback on failure
- _Owner: DevOps Team | Est: 5 days_

#### [❌] 10. Cost Optimization

**Evidence**: DynamoDB on-demand (expensive at scale); no CloudFront cache tuning  
**Opportunity**: 40-60% potential cost reduction

**Tasks:**

- [ ] **DynamoDB provisioned capacity** with auto-scaling (60% cost reduction)
- [ ] **CloudFront cache tuning** - longer TTLs for static assets (365 days)
- [ ] **Lambda ARM architecture** (20% cheaper, 10% faster)
- _Owner: Infrastructure Team | Est: 3 days_
- **Target**: Monthly cost from ~$50 to <$35

---

### P3 - BACKLOG (Future Sprints)

#### [❌] 11. Developer Experience

- **Hot reload for backend**: `tsx` or `nodemon` for Lambda handler development
- **Local DynamoDB**: Docker compose for full offline development
- **Environment parity**: Local → dev → prod environment consistency

#### [❌] 12. PWA & Offline Support

- Service worker for room data caching
- Background sync for votes during network loss
- Installable app with custom splash screen

#### [❌] 13. Advanced Features

- **Moderator password**: Implement hashed password field already in `Room` type
- **Multi-region**: Active-active deployment (us-east-1 + eu-central-1)
- **Export results**: CSV/PDF export of voting history

#### [❌] 14. Documentation & Runbooks

- Architecture decision records (ADRs)
- Operational runbooks (monitoring, incident response)
- Performance benchmarking guide

## Implementation Roadmap

### Phase 1: Security Hardening (Week 1-2)

**Priority**: Critical - Must complete before further scaling

1. Rate Limiting Completion (P0 #1) - 3 days
2. IAM Permission Refinement (P0 #3) - 2 days
3. Monitoring Enhancement (P0 #2) - 5 days
   **Deliverables**: API keys, WAF, granular IAM policies, operational dashboards

### Phase 2: Performance Optimization (Week 3-4)

**Priority**: High - Affects scalability and user experience

1. DynamoDB Query Optimization (P1 #4) - 7 days **(85% complete)**
   - ✅ Caching implemented (participants 3s, active rounds 2s, rooms 10s)
   - ✅ Vote polling loop reduced (8→4 attempts)
   - ✅ GSI on VOTES_TABLE deployed
   - ✅ N+1 pattern fixed in round-history.ts
   - ⚠️ Composite GSI on ROUNDS_TABLE pending
   - ⚠️ join-room.ts optimization pending (5→3 queries)
2. Frontend Memory Leak Fixes (P1 #5) - 5 days **(60% complete)**
   - ✅ Custom interval hooks with guaranteed cleanup
   - ✅ Simplified countdown logic (94→40 lines)
   - ⚠️ hookId cleanup in dependency arrays pending
   - ⚠️ setTimeout cleanup pending
   - ⚠️ Exponential backoff for polling errors pending
     **Deliverables**: Caching implemented, memory leaks reduced, GSI optimization pending

### Phase 3: Testing & Monitoring (Week 5-6)

**Priority**: High - Ensures reliability of above changes

1. Critical Path Testing (P1 #6) - 6 days **(40% complete)**
   - ✅ WebSocket integration tests added (websocket-connect, websocket-disconnect)
   - ✅ Error scenario tests added (validation, DynamoDB errors, room not found)
   - ⚠️ Concurrent voting tests pending
   - ⚠️ Frontend hook tests pending
   - ⚠️ Load testing with k6 pending
2. WAF/DDoS Protection (P2 #8) - 3 days **(0% complete)**
   **Deliverables**: WebSocket tests implemented, error scenarios covered, WAF protection pending

### Phase 4: Final Verification (Week 7)

**Priority**: Medium - Ensures long-term maintainability

1. Frontend Bundle Optimization (P2 #7) - 4 days
2. Deployment Reliability (P2 #9) - 5 days
3. Cost Optimization (P2 #10) - 3 days
   **Deliverables**: <150kb bundles, blue-green deployment, 40% cost reduction

## Technical Debt Assessment (Updated)

| Area              | Debt Level     | Justification                                     | Progress |
| ----------------- | -------------- | ------------------------------------------------- | -------- |
| **Security**      | **Low**        | Rate limiting and IAM refined, WAF deployed       | 80%      |
| **Observability** | **Medium**     | Alarms, dashboards, and X-Ray tracing implemented | 70%      |
| **Testing**       | **High**       | <5% test coverage, missing critical path tests    | 50%      |
| **Performance**   | **Medium**     | N+1 queries partially fixed, caching implemented  | 80%      |
| **Reliability**   | **Medium**     | No rollback, single-region, deployment gaps       | 30%      |
| **Cost**          | **Low-Medium** | On-demand pricing, no optimization                | 10%      |

## Success Metrics

| Metric                | Current  | Target   | Measurement          | Owner          |
| --------------------- | -------- | -------- | -------------------- | -------------- |
| P99 Latency (vote)    | ~500ms   | <200ms   | CloudWatch Metrics   | Backend        |
| Error Rate            | Unknown  | <0.1%    | Lambda error logs    | DevOps         |
| Test Coverage         | <5%      | >70%     | Vitest coverage      | QA             |
| Bundle Size           | 215kb    | <150kb   | Vite bundle analyzer | Frontend       |
| Deployment Time       | ~5min    | <2min    | GitHub Actions       | DevOps         |
| Monthly Cost          | ~$50     | <$35     | AWS Cost Explorer    | Infrastructure |
| DynamoDB Ops/vote     | Up to 16 | <8       | CloudWatch Metrics   | Backend        |
| WebSocket Connections | No limit | 100/room | API Gateway Metrics  | Infrastructure |

## Risk Matrix

| Risk                    | Probability | Impact | Mitigation                           | Status |
| ----------------------- | ----------- | ------ | ------------------------------------ | ------ |
| DoS Attack              | Medium      | High   | Rate limiting + WAF                  | P0 #1  |
| Data Corruption         | Low         | High   | Validation + idempotency             | ✅     |
| AWS Region Outage       | Low         | High   | Multi-region (P3)                    | P3     |
| Cost Overrun            | Medium      | Medium | Provisioned capacity + alerts        | P2 #10 |
| Deployment Failure      | Medium      | Medium | Blue-green + rollback                | P2 #9  |
| Memory Leaks            | High        | Medium | Interval cleanup + hook optimization | P1 #5  |
| Performance Degradation | Medium      | Medium | Query optimization + caching         | P1 #4  |

## Architectural Strengths to Preserve

1. **Clean monorepo structure** – Workspaces with clear dependencies
2. **Real-time WebSocket with polling fallback** – Resilient connectivity
3. **Comprehensive CDK infrastructure** – Full IaC with custom domains
4. **Type safety throughout** – Shared TypeScript interfaces
5. **Local development server** – Excellent developer experience
6. **Zod validation implemented** – Runtime type safety for all handlers

## Recommendation

**Immediate focus on completing security hardening (Phase 1)** - rate limiting and IAM refinement present the highest risk. The recent voting bug fixes have stabilized core functionality, but production-scale deployment requires the security and performance optimizations outlined above.

**Execution approach**:

1. **Parallel workstreams**: Security (P0) + Performance (P1) can run concurrently with separate teams
2. **Incremental deployment**: Blue-green for API changes, feature flags for frontend
3. **Continuous validation**: Load testing after each phase to verify improvements

**Estimated engineering effort**: 7 weeks with 2-3 engineers focused, or 4-5 weeks with dedicated cross-functional team. All P0-P1 items addressable within 6 weeks, reaching production-ready state by end of Phase 3.

---

**Next Steps**:

1. Assign owners for P0 items (Infrastructure, Security, DevOps teams)
2. Schedule security penetration testing for Week 3
3. Begin Phase 1 implementation immediately

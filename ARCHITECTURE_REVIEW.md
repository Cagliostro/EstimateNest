# EstimateNest Architectural Review & Optimization Roadmap

**Date**: April 17, 2026  
**Reviewer**: Architectural Assessment  
**Version**: 1.0

## Executive Summary

EstimateNest demonstrates solid architectural foundations with clean separation of concerns, comprehensive CDK infrastructure, and real-time WebSocket communication. However, significant gaps exist in **security**, **observability**, **testing**, and **production readiness**. The application requires hardening before scaling to production workloads.

## Critical Issues (P0 – Immediate Action Required)

### 1. Security: Input Validation Missing ⚠️

**Risk**: High (Injection attacks, data corruption)  
**Evidence**: Backend handlers accept WebSocket/API messages without validation (`vote.ts:811`, `join-room.ts:294`)  
**Impact**: Malformed or malicious payloads can crash services or corrupt data  
**Fix**: Implement Zod schemas in shared package, validate all incoming messages

### 2. Security: No Rate Limiting ⚠️

**Risk**: High (DoS, resource exhaustion)  
**Evidence**: API Gateway has no usage plans; Lambda functions have no throttling  
**Impact**: Single user can flood system, exhausting DynamoDB RCU/WCU  
**Fix**: Add API Gateway usage plans (100 req/min per IP), Lambda reserved concurrency

### 3. Observability: Zero Monitoring ⚠️

**Risk**: High (Blind operations)  
**Evidence**: No CloudWatch alarms, metrics, or dashboards defined in CDK  
**Impact**: Cannot detect outages, performance degradation, or abuse  
**Fix**: Add CloudWatch alarms for Lambda errors (>1%), DynamoDB throttling, WebSocket disconnections

### 4. Data Integrity: Race Conditions in Voting ⚠️

**Risk**: Medium-High (Duplicate votes, inconsistent state)  
**Evidence**: `vote.ts` uses `TransactWriteCommand` but lacks idempotency keys  
**Impact**: Network retries can cause duplicate votes; WebSocket reconnection may double-count  
**Fix**: Add idempotency keys (participantId + roundId + timestamp hash); implement conditional writes

## High Priority (P1 – Next Sprint)

### 5. Performance: DynamoDB Query Inefficiencies

**Evidence**: `join-room.ts` makes 4+ queries; `vote.ts` has multiple round-trips  
**Impact**: Increased latency (~100-200ms per operation), higher DynamoDB costs  
**Optimization**:

- **Composite GSI**: `(roomId, participantId)` for frequent participant lookups
- **Batch Operations**: Combine `GetCommand` operations where possible
- **Caching**: Redis/DAX for participant lists (TTL: 30s)

### 6. Frontend: Memory Leaks & Resource Cleanup

**Evidence**: `use-room-connection.ts` has multiple `setInterval` without guaranteed cleanup  
**Impact**: Memory bloat over time, zombie intervals after navigation  
**Fix**:

- Use `useEffect` cleanup functions with dependency arrays
- Implement `AbortController` for polling requests
- Add React error boundaries for graceful degradation

### 7. Security: Overly Broad IAM Permissions

**Evidence**: `estimateneest-stack.ts` lines 340-357 grant `ReadWriteData` broadly  
**Impact**: Lambda compromise → full table access  
**Fix**: Principle of least privilege – granular permissions per handler:

- `createRoomHandler`: `PutItem` on Rooms, RoomCodes only
- `voteHandler`: `UpdateItem` on Votes, `GetItem` on Rounds

### 8. Testing: Critical Paths Untested

**Evidence**: Only 2 test files (`placeholder.test.ts`, `api-client.test.ts`)  
**Impact**: Regression risk, especially for voting/round logic  
**Fix**:

- **Integration tests**: Vitest + LocalStack for DynamoDB operations
- **E2E tests**: Playwright for user flows (create room → vote → reveal)
- **Load tests**: k6 for WebSocket concurrency (100+ connections)

## Medium Priority (P2 – Within 2-3 Sprints)

### 9. Frontend: Bundle Size & Code Splitting

**Evidence**: Single bundle (215kb gzipped); no lazy loading  
**Impact**: Slow initial load (~3-4s on 3G), poor Core Web Vitals  
**Optimization**:

- Route-based code splitting (`React.lazy` + `Suspense`)
- Dynamic import for legal page, room components
- Bundle analyzer plugin for Vite

### 10. Infrastructure: No WAF/DDOS Protection

**Evidence**: CloudFront distributions lack AWS WAF integration  
**Risk**: Application-layer attacks (SQL injection, XSS via WebSocket)  
**Fix**:

- WAF with OWASP Core Rule Set
- Rate-based rules (100 requests/5min per IP)
- Geographic blocking (optional)

### 11. CI/CD: Deployment Reliability

**Evidence**: `deploy.yml` has no rollback strategy; frontend build depends on infra outputs  
**Risk**: Broken deployment → extended downtime  
**Improvements**:

- **Blue-green deployments**: Route 53 weighted routing
- **Health checks**: Lambda function validation before traffic shift
- **Rollback automation**: CloudFormation stack rollback on failure

### 12. Observability: Distributed Tracing

**Evidence**: No correlation IDs across Lambda → WebSocket → DynamoDB  
**Impact**: Cannot trace user journey through system  
**Fix**:

- AWS X-Ray integration for Lambda/DynamoDB
- Propagate `x-correlation-id` through all layers
- Structured logging with request context

### 13. Cost Optimization

**Evidence**: DynamoDB on-demand (expensive at scale); no CloudFront cache tuning  
**Opportunities**:

- **DynamoDB**: Switch to provisioned capacity with auto-scaling (60% cost reduction)
- **CloudFront**: Longer TTLs for static assets (365 days), compress WebSocket responses
- **Lambda**: ARM architecture (20% cheaper, 10% faster)

## Low Priority (P3 – Backlog)

### 14. Developer Experience

- **Hot reload for backend**: `tsx` or `nodemon` for Lambda handler development
- **Local DynamoDB**: Docker compose for full offline development
- **Environment parity**: Local → dev → prod environment consistency

### 15. Frontend: PWA & Offline Support

- Service worker for room data caching
- Background sync for votes during network loss
- Installable app with custom splash screen

### 16. Advanced Features

- **Moderator password**: Implement hashed password field already in `Room` type
- **Multi-region**: Active-active deployment (us-east-1 + eu-central-1)
- **Export results**: CSV/PDF export of voting history

### 17. Documentation & Runbooks

- Architecture decision records (ADRs)
- Operational runbooks (monitoring, incident response)
- Performance benchmarking guide

## Technical Debt Assessment

| Area          | Debt Level     | Justification                           |
| ------------- | -------------- | --------------------------------------- |
| Security      | **High**       | Missing validation, rate limiting, WAF  |
| Observability | **High**       | No monitoring, tracing, or alerting     |
| Testing       | **High**       | <5% test coverage, no integration tests |
| Performance   | **Medium**     | N+1 queries, no caching, large bundles  |
| Reliability   | **Medium**     | No rollback, single-region, no backups  |
| Cost          | **Low-Medium** | On-demand pricing, no optimization      |

## Implementation Roadmap

### Phase 1 (Critical – 2-3 weeks)

1. **Security hardening**: Zod validation + API Gateway rate limiting
2. **Basic monitoring**: CloudWatch alarms for errors & latency
3. **Idempotency**: Fix vote race conditions

### Phase 2 (High – 4-6 weeks)

1. **Performance optimization**: DynamoDB GSIs + query consolidation
2. **Testing foundation**: Integration tests for core flows
3. **IAM least privilege**: Granular permissions per handler

### Phase 3 (Medium – 8-12 weeks)

1. **Frontend optimization**: Code splitting + bundle analysis
2. **WAF implementation**: OWASP rules + geographic controls
3. **Deployment reliability**: Blue-green + automated rollback

### Phase 4 (Low – Ongoing)

1. **PWA features**: Offline support + installability
2. **Multi-region**: Active-active deployment
3. **Advanced analytics**: Voting patterns + team insights

## Success Metrics

| Metric             | Current | Target | Measurement          |
| ------------------ | ------- | ------ | -------------------- |
| P99 Latency (vote) | ~500ms  | <200ms | CloudWatch Metrics   |
| Error Rate         | Unknown | <0.1%  | Lambda error logs    |
| Test Coverage      | <5%     | >70%   | Vitest coverage      |
| Bundle Size        | 215kb   | <150kb | Vite bundle analyzer |
| Deployment Time    | ~5min   | <2min  | GitHub Actions       |
| Monthly Cost       | ~$50    | <$35   | AWS Cost Explorer    |

## Risk Matrix

| Risk               | Probability | Impact | Mitigation                    |
| ------------------ | ----------- | ------ | ----------------------------- |
| DoS Attack         | Medium      | High   | Rate limiting + WAF           |
| Data Corruption    | Low         | High   | Validation + idempotency      |
| AWS Region Outage  | Low         | High   | Multi-region (Phase 4)        |
| Cost Overrun       | Medium      | Medium | Provisioned capacity + alerts |
| Deployment Failure | Medium      | Medium | Blue-green + rollback         |

## Architectural Strengths to Preserve

1. **Clean monorepo structure** – Workspaces with clear dependencies
2. **Real-time WebSocket with polling fallback** – Resilient connectivity
3. **Comprehensive CDK infrastructure** – Full IaC with custom domains
4. **Type safety throughout** – Shared TypeScript interfaces
5. **Local development server** – Excellent developer experience

## Recommendation

**Immediate focus on security and observability** before adding new features. The application has solid foundations but requires production hardening. Start with P0 items (validation, rate limiting, monitoring) to establish baseline security, then address performance and testing gaps.

**Estimated engineering effort**: 3-4 months to reach production-ready state with all P0-P2 items addressed.

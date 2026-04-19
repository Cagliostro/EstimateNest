# EstimateNest Agent Guidelines

Monorepo: npm workspaces with frontend (React/Vite), backend (Lambda/DynamoDB), infrastructure (CDK), and shared packages.

## Environment

- Node.js >=24.0.0, npm >=10.0.0
- AWS CDK: `npm install -g aws-cdk`
- AWS CLI configured for deployment

## Root Commands

```bash
npm run build    # shared → backend → frontend → infrastructure (order matters)
npm run dev      # frontend (5173) + backend local server concurrently
npm run lint     # all workspaces
npm run test     # Vitest in frontend/backend
npm run format   # Prettier
```

Workspace-specific: `npm run lint --workspace=frontend`

## Build Order

`packages/shared` → `backend` → `frontend` → `infrastructure`

Never build infrastructure before shared/backend, and never build frontend before shared.

## Testing

```bash
# Run all tests
npm run test --workspace=frontend
npm run test --workspace=backend

# Single test file
npx vitest run src/path/to/test.test.ts

# Pattern match
npm run test -- -t "test name"

# Coverage
npm run test:coverage --workspace=frontend
```

## Code Style

**Prettier**: 2 spaces, single quotes, semicolons, trailing commas (es5), 100 print width

**TypeScript**:

- Strict mode, no unused locals/params
- Backend: `moduleResolution: node`, target ES2022
- Frontend: `moduleResolution: bundler`, target ES2020
- Frontend path alias: `@/*` → `src/*`

**Imports**: External → `@estimatenest/shared` → Relative (`./`, `../`)

**Naming**:

- Types: PascalCase (`Room`, `Participant`)
- Variables/Functions: camelCase (`roomId`, `generateShortCode`)
- Constants: UPPER_SNAKE_CASE (`ROOMS_TABLE`, `DEFAULT_DECKS`)
- Lambda handlers: kebab-case (`create-room.ts`)

## Monorepo Patterns

- Shared types/utilities: `packages/shared`
- Workspace imports: `@estimatenest/shared`
- Backend uses relative imports for shared
- Each workspace extends `tsconfig.base.json`

## Infrastructure (CDK)

**Bootstrap**: `npm run bootstrap --workspace=infrastructure -- --context env=dev`

**Deploy**: `npm run deploy:dev` or `npm run deploy:prod`

**Context**: `--context env=dev|prod` determines stack configuration, `--context color=blue|green` for blue-green deployments (auto-determined in CI: prod→green, dev→blue)

**Outputs extracted**: `FrontendBucketName`, `CloudFrontDistributionId`, `CloudFrontDomainName`, `WwwCloudFrontDomainName`, `RestApiUrl`, `WebSocketUrl`, `FrontendUrl`

**Frontend build**: Requires actual URLs from CDK outputs as env vars:

- `VITE_API_URL`
- `VITE_WEBSOCKET_URL`
- `VITE_FRONTEND_URL`

## Deployment Flow

- `main` → production (green stack, weight 0)
- `development` → development (blue stack, weight 100)
- CDK outputs are used to build frontend with real URLs before uploading to S3
- Blue-green deployments: production deploys to green stack with weight 0, traffic switched after verification
- Traffic switching: `./infrastructure/scripts/switch-traffic.sh prod green` (or `blue`, `rollback`)
- Rollback automation: script detects current active color and switches to opposite
- Health checks: `/health` endpoint validated before frontend build

## CI Build Env Vars (Ubuntu)

Required for CI builds:

```
ROLLUP_NATIVE: 0
NODE_OPTIONS: --max-old-space-size=4096
SHARP_IGNORE_GLOBAL_LIBVIPS: 1
SHARP_DIST_BASE_URL: https://github.com/lovell/sharp-libvips/releases/download
SHARP_BINARY_HOST: https://github.com/lovell/sharp/releases/download
SHARP_LIBVIPS_BINARY_HOST: https://github.com/lovell/sharp-libvips/releases/download
```

## Verification Steps

**Before committing**: lint → build → test

```bash
npm run lint && npm run build && npm run test
```

**After code changes**: Verify build order is respected when adding new packages.

**After CDK changes**: Run `npm run synth --workspace=infrastructure` to validate before deploy.

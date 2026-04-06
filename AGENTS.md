# Agent Guidelines for EstimateNest

This document provides guidelines for AI agents working in the EstimateNest codebase. It includes build commands, code style conventions, and workspace patterns.

## Project Overview

EstimateNest is a planning poker room application built as a TypeScript monorepo using npm workspaces with frontend (React/Vite), backend (AWS Lambda/DynamoDB), infrastructure (AWS CDK), and shared packages.

## Environment Requirements

- Node.js >=24.0.0, npm >=10.0.0
- AWS CDK installed globally (`npm install -g aws-cdk`) for infrastructure commands

## Build Commands

### Root Workspace

```bash
npm run build          # Build all workspaces
npm run dev            # Start frontend and backend dev servers concurrently
npm run lint           # Lint all workspaces
npm run test           # Run tests in all workspaces
npm run format         # Format code with Prettier
```

### Workspace-Specific Commands

| Workspace          | Commands                                                              |
| ------------------ | --------------------------------------------------------------------- |
| `frontend/`        | `dev`, `build`, `preview`, `lint`, `test`, `test:ui`, `test:coverage` |
| `backend/`         | `dev`, `build`, `test`, `test:coverage`, `lint`                       |
| `infrastructure/`  | `synth`, `diff`, `deploy`, `destroy`, `lint`, `build`                 |
| `packages/shared/` | `build`, `lint`                                                       |

## Linting & Formatting

- **ESLint**: TypeScript plugins per workspace
- **Prettier**: Single quotes, 2 spaces, 100 print width, trailing commas ES5
- **EditorConfig**: Indent 2 spaces, single quotes for JS/TS

Run linting: `npm run lint` (all) or `npm run lint --workspace=frontend`
Run formatting: `npm run format`

## Testing

- **Test Runner**: Vitest across frontend and backend
- **Coverage**: `npm run test:coverage` in each workspace
- **UI Mode**: Frontend supports `npm run test:ui`

### Running a Single Test

```bash
# In workspace directory
npm run test -- path/to/test/file.test.ts
# Using vitest directly
npx vitest run src/components/Button.test.tsx
# Pattern matching
npm run test -- -t "button click"
```

## Code Style Guidelines

### Formatting Rules

- Indentation: 2 spaces
- Quotes: Single quotes for JS/TS
- Semicolons: Required
- Trailing commas: ES5 style
- Print width: 100 characters
- JSX quotes: Single quotes

### TypeScript Configuration

- Strict mode enabled
- No unused locals/parameters (errors)
- Module resolution: `node` (backend) / `bundler` (frontend)
- Target: ES2022 (backend), ES2020 (frontend)

### Import Ordering

1. External dependencies (React, AWS SDK, etc.)
2. Internal workspace imports (`@estimatenest/shared`)
3. Relative imports (`./`, `../`)

### Naming Conventions

- Types/Interfaces: PascalCase (`Room`, `Participant`)
- Variables/Functions: camelCase (`roomId`, `generateShortCode`)
- Constants: UPPER_SNAKE_CASE (`ROOMS_TABLE`, `DEFAULT_DECKS`)
- Component Files: PascalCase (`RoomPage.tsx`)
- Handler Files: kebab-case (`create-room.ts`)

### Error Handling

- Use `try/catch` for async operations
- Log errors with `console.error` and context
- Return user-friendly error responses in API handlers
- Avoid exposing internal error details in production

### React Components

- Functional components with TypeScript
- Explicit props interfaces
- Tailwind CSS for styling
- Follow React hooks conventions

### AWS Lambda Handlers

- `async/await` pattern
- Validate env vars with `process.env.VAR_NAME!`
- Use shared types for consistency
- Implement proper CORS headers when needed

## Monorepo Conventions

- Shared code in `packages/shared`
- Workspace references use `@estimatenest/` prefix
- Build shared package first
- Frontend path alias: `@/*` → `src/*`
- Backend uses relative imports
- Each workspace extends `tsconfig.base.json`

## Infrastructure as Code

- AWS CDK (TypeScript) with environment-aware stacks
- Use `cdk deploy --all` to deploy all stacks
- Use `--context env=dev` for environment-specific deployments

## Quick Reference

```bash
npm run dev            # Start development
npm run build          # Build all workspaces
npm run deploy:dev     # Deploy to development
npm run deploy:prod    # Deploy to production
```

---

**Note**: No Cursor rules (`.cursor/rules/` or `.cursorrules`) or Copilot rules (`.github/copilot-instructions.md`) were found in the repository.

_Last updated: April 2025_

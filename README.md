# EstimateNest

Planning Poker Room for Team Estimations.

## Overview

EstimateNest is a real‑time, collaborative planning‑poker tool for agile teams. Create a room, share a short URL, and estimate stories together—no registration required.

## Features

- **Zero‑sign‑up rooms** with short URLs (e.g., `https://estimatenest.net/ABC123`)
- **Real‑time voting** using WebSockets (AWS API Gateway)
- **Moderator controls** (reveal, new round, optional room password)
- **Customizable card decks** (Fibonacci, T‑shirt sizes, powers‑of‑two, or your own scale)
- **Participant profiles** with generated avatars (initials + color)
- **Responsive web‑app** for desktop and mobile browsers
- **Serverless AWS backend** (Lambda, DynamoDB, S3, CloudFront)
- **Automatic cleanup** – rooms expire after 14 days

## Architecture

```
[CloudFront] → [S3 (React App)]
          ↓
[API Gateway] ←→ [Lambda (WebSocket/REST)]
          ↓
    [DynamoDB] (Rooms, Participants, Rounds, Votes)
```

## Development

### Prerequisites

- Node.js 24+
- AWS CLI configured with appropriate credentials
- AWS CDK CLI (`npm install -g aws-cdk`)

### Workspaces

This repository is a monorepo using npm workspaces:

- `frontend/` – React 18 + TypeScript + Vite + Tailwind CSS
- `backend/` – AWS Lambda functions (Node.js 24, TypeScript)
- `infrastructure/` – AWS CDK stack (TypeScript)
- `packages/shared/` – Shared TypeScript types and utilities

### Quick Start

1. Clone the repository:

   ```bash
   git clone https://github.com/Cagliostro/EstimateNest.git
   cd EstimateNest
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Start the development environment:

   ```bash
   npm run dev
   ```

4. Deploy the development stack (first time):
   ```bash
   npm run deploy:dev
   ```

### Scripts

| Script                 | Purpose                              |
| ---------------------- | ------------------------------------ |
| `npm run build`        | Build all workspaces                 |
| `npm run dev`          | Start frontend & backend dev servers |
| `npm run test`         | Run tests in all workspaces          |
| `npm run lint`         | Lint all workspaces                  |
| `npm run deploy:dev`   | Deploy the dev AWS stack             |
| `npm run deploy:prod`  | Deploy the prod AWS stack            |
| `npm run destroy:dev`  | Tear down the dev stack              |
| `npm run destroy:prod` | Tear down the prod stack             |

## Deployment

Two environments are managed via AWS CDK:

- **`dev`** – used for development and testing
- **`prod`** – production environment

Deployment is automated via GitHub Actions; each push to `main` triggers a production deploy, each push to `development` triggers a dev deploy.

## Infrastructure

The AWS stack is defined in `infrastructure/` using CDK constructs. Key resources:

- **S3 + CloudFront** – Hosting for the React frontend
- **API Gateway (REST + WebSocket)** – Entry point for backend APIs
- **Lambda** – Serverless functions for room management, real‑time messaging
- **DynamoDB** – Persistent storage for rooms, participants, rounds, votes
- **Route 53 + ACM** – Domain management and SSL certificates
- **CloudWatch** – Logging and monitoring

## License

MIT – see [LICENSE](LICENSE).

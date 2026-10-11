# 00 — Repository Inspection

_Date: 2026-10-10 · Phase 0 (planning)_

## Findings

| Item              | Result                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| Project directory | Empty. No source, assets, menu data, brand files, or prior integrations. Not a git repository.           |
| Node.js           | v22.16.0 (meets Next.js 16 / modern tooling requirements; Node 24 LTS recommended for production parity) |
| npm               | 11.4.1                                                                                                   |
| pnpm              | Not installed — enable via `corepack enable` in Phase 1                                                  |
| git               | 2.52.0                                                                                                   |
| Docker            | 29.6.1 — usable for local PostgreSQL and Testcontainers integration tests                                |
| psql              | Not installed — not required (Docker image provides it)                                                  |
| GitHub CLI        | 2.96.0 — usable for repo/CI setup if a remote is created                                                 |
| Vercel CLI        | Not installed (optional; `npm i -g vercel` when deployment work begins)                                  |
| OS                | Windows 11 — scripts must be cross-platform (no bash-only npm scripts)                                   |

## Consequences

- Greenfield: every architectural decision is open; nothing to migrate or preserve.
- **No owner-supplied content exists** (menu, prices, hours, logo, photography, POS, tax registration). All such data will be seeded as clearly-labelled placeholders (`[PLACEHOLDER]`, `DEV ONLY`) and listed in [07-open-decisions.md](07-open-decisions.md).
- Windows development host: use `cross-env`-free scripts (Node-based), LF line endings via `.gitattributes`, and Docker for Postgres.

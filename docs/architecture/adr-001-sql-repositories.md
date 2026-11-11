# PostgreSQL repositories and the shared server core

2026-11-08 · Accepted implementation decision · Supersedes the Prisma access-layer proposal in TDD v1.0

PRISM uses parameterized PostgreSQL SQL through pg in production and the same SQL schema through file-backed PGlite for local development. The authoritative state stays on the backend in both modes. iOS uses SQLite for its local replica and durable outbox.

The initial specification proposed Prisma. The implementation instead keeps SQL transactions, composite ownership foreign keys, row-level security, immutable audit triggers, generated unit columns and commit-ordered synchronization in one model. It does not maintain a second ORM schema that could omit these constraints. The controlled migration command records a checksum and refuses to rewrite an already applied initial migration.

packages/core contains the canonical command handlers, serializers, ownership checks, idempotency and business transactions. API wraps it with HTTP and OIDC; Worker calls the same services. packages/fsrs and packages/planner remain separately testable. apps/mobile and apps/web consume the same HTTP contract; generated TypeScript declarations are in packages/types.

The production Worker uses its own PostgreSQL connection and a role permitted to ingest global public paper metadata. API's runtime role only reads that metadata. Both roles are non-owners without superuser or BYPASSRLS. Local PGlite has one exclusive connection, so its Worker runs inside the API process; a second process must not open the same PGlite directory.

Server packages export TypeScript and declare tsx as a runtime dependency in their executable API and Worker packages. Build verifies types; Docker runs the declared source runtime. PRISM does not claim to produce a standalone compiled backend JavaScript binary.

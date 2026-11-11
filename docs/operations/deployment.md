# PRISM deployment and recovery

PRISM currently provides a verified local application and deployment artifacts. No production account, public domain, OIDC issuer, APNs credentials, or Apple signing identity has been configured in this workspace. The commands below describe the controlled deployment path; they are not evidence of an existing production release.

## Services and identity

Deploy three processes from the same revision: API, Web and Worker. Use managed PostgreSQL 16 or higher and Redis. API and Worker use different non-owner database roles. Web only accesses the API and Redis session storage; it never receives a database credential.

Use separate HTTPS endpoints for the Web and public API, such as prism.example and api.prism.example. Browser calls to the Web's /api/v1 path go through its BFF, where the opaque session becomes a bearer token. iOS calls the public API endpoint with its bearer token. Do not configure a reverse-proxy rule that bypasses the Web BFF for browser API requests.

Configure valid TLS on public endpoints and encrypted database/Redis connections where those services cross a network boundary. For managed services, use the provider's TLS connection strings and trusted certificates, such as PostgreSQL sslmode=verify-full and a rediss URL. Network, backup and disk encryption are deployment responsibilities; local Docker services are development fixtures.

Register one OIDC Web confidential client and one mobile public PKCE client. Configure the actual issuer, audience and allowlisted subject rather than inferring ownership from an email address. Register the exact Web callback URL and the mobile redirect returned by /auth/config. Complete a real sign-in, refresh, logout and rejected-account test against the selected issuer before release.

## Secrets and configuration

[.env.example](../../.env.example) lists configuration names. Inject production secrets using the hosting platform's secret store. Do not commit .env files, tokens, signing material or connection passwords.

| Process | Required configuration                                                                                                                                                                        |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API     | NODE_ENV=production, PRISM_AUTH_MODE=oidc, PRISM_HOST, DATABASE_URL, OIDC_ISSUER, OIDC_AUDIENCE, PRISM_ALLOWED_SUBJECT, PRISM_USER_ID, PRISM_SIGNING_SECRET, PRISM_WEB_ORIGIN, PRISM_DATA_DIR |
| Web     | NODE_ENV=production, PRISM_API_URL, PRISM_WEB_ORIGIN, REDIS_URL, PRISM_SESSION_SECRET, PRISM_OIDC_CLIENT_ID, PRISM_OIDC_REDIRECT_URI; client secret if the issuer requires it                 |
| Worker  | Production identity configuration, its writer DATABASE_URL, REDIS_URL, PRISM_DATA_DIR, PRISM_ARXIV_USER_AGENT; PRISM_PUSH_ENABLED=true when push is configured                                |
| iOS     | HTTPS EXPO_PUBLIC_API_URL ending in /api/v1, EXPO_PUBLIC_DEV_AUTH=0, EAS project and registered scheme/callback                                                                               |

Use independent random secrets of at least 32 characters for cursor signing and Web sessions. PRISM_PUSH_ENCRYPTION_KEY is a base64-encoded 32-byte AES key, shared only by the API/Worker instances that store and decrypt device tokens. Push is enabled only after the Expo project and APNs credentials are configured and the user opts in.

The local dev launcher reads an optional root .env, refuses NODE_ENV=production, then explicitly selects loopback-only development authentication. Production must use the service start commands, not the dev launcher.

## Initial database setup

Run migrations with a controlled migration-owner connection, never the API runtime credential:

```sh
pnpm db:migrate
pnpm db:provision
pnpm db:runtime-role
```

The migration command requires MIGRATION_DATABASE_URL. Provisioning also requires PRISM_USER_ID, PRISM_ALLOWED_SUBJECT and PRISM_USER_EMAIL, with optional PRISM_DISPLAY_NAME and PRISM_TIMEZONE. The command refuses to rebind an existing UUID to a different subject.

Create the API role with PRISM_RUNTIME_ROLE and PRISM_RUNTIME_DB_PASSWORD. Repeat for the Worker with PRISM_ROLE_KIND=worker. API receives only SELECT on global arXiv metadata; Worker can ingest it. Both roles have RLS-protected access to user data and neither receives DDL, TRUNCATE, DELETE, superuser or BYPASSRLS privileges.

The initial migration checksum is recorded in public.prism_migrations. Schema changes after deployment require an explicit subsequent migration. Do not overwrite an applied schema file or use ORM schema synchronization to remove custom constraints.

## Build and start

The Dockerfile contains api, worker and web targets. It excludes runtime data and secrets from the build context, installs the production dependency graph, and runs as the unprivileged node user.

```sh
docker build --target api -t prism-api:local .
docker build --target worker -t prism-worker:local .
docker build --target web -t prism-web:local .
```

Provide configuration through the deployment environment. API listens on port 4000 and Web on port 3000. Terminate HTTPS with the hosting platform or a correctly configured gateway. PRISM_API_URL must point to the API, not back to the Web's own BFF. Restrict direct access to internal listeners and managed service credentials.

Mount a persistent writable PRISM_DATA_DIR for generated exports. Exports expire after 24 hours and can be regenerated. Do not bake an existing .data directory into an image.

Local development uses one file-backed PGlite process, so the Worker runs inside API. Production uses PostgreSQL and a separate Worker. Never start another PGlite process against an API's open data directory. Production Worker requires Redis to coordinate arXiv access across processes; do not scale independent uncoordinated ingestion clients.

## Background operation and monitoring

Worker keeps job records, leases, bounded retries and dedupe keys in PostgreSQL, with Redis delivery. API/Worker logs include request, operation and job identifiers without token payloads. Monitor failed/dead jobs, pending outbox age, database connection failures, digest delivery, export failures and HTTP error rates. A source ingestion failure must not stop knowledge, reviews or workout recording.

Changing subscriptions does not remove saved paper history. Digest generation rechecks enabled subscriptions. Quiet hours are rechecked before push delivery; external push transport is at least once and the client deduplicates notification IDs.

## Backups and restoration

Enable daily encrypted database backups and, where supported, point-in-time recovery. Initial planning targets are RPO 24 hours and RTO 4 hours; measure the chosen infrastructure rather than treating the local test duration as a production guarantee. Keep encryption keys and identity configuration available through a separate, controlled recovery path.

Use managed backup tooling or pg_dump with connection credentials supplied through a protected service file or environment. Do not put a password-bearing URL in command arguments. Encrypt offsite archives, restrict their access, test retention, and record the database migration checksum. Back up persistent artifact storage consistently if generated export downloads must survive a restore.

Restore into a new isolated database, never over an unverified live database. Compare record counts and hashes, including immutable review events, FSRS state, research history, workout rows and generated unit columns. Reapply runtime grants and validate authentication with the intended non-owner role. The local populated PostgreSQL restore evidence is [backup-restore.json](../verification/backup-restore.json).

Before reconnecting devices after a rollback, run the controlled recovery command:

```sh
pnpm exec tsx scripts/database.ts after-restore
```

This requires MIGRATION_DATABASE_URL and PRISM_USER_ID. It rotates the synchronization stream generation without changing any business object ID or revision history, expires derived export artifacts, and releases interrupted jobs. Old signed cursors then produce an explicit recovery condition even if new revision numbers later catch up. Devices preserve their unsynchronized operations and retain a device recovery copy before installing the restored snapshot. Review that copy explicitly; do not blindly replay acknowledged historical ratings into a different schedule.

A daily backup can predate recent acknowledged changes. The declared RPO describes this disaster-recovery exposure; it must not be hidden as successful zero-loss restoration. Configure PITR and validate the actual window required for personal use.

## Release gates still requiring the owner's environment

Before declaring the full PRD Definition of Done, verify production OIDC and HTTPS, managed backup recovery and monitoring, real iOS offline/termination recovery, Keychain/logout, notification delivery and taps, file sharing, VoiceOver, and TestFlight signing/distribution. Then use the application for two consecutive weeks without a release-blocking defect. Automated tests and a Hermes export do not replace those release steps.

## Reproducing isolated database checks

Use a dedicated PostgreSQL test server whose administrator may create and drop scratch databases. It must not contain personal or production data. The disposable fixture creates a fresh randomly named database for each run, applies the same SQL Schema and grants the test runtime role access only inside that scratch database. This is deliberately broader than the production role provisioning so constraint, RLS and deletion defenses can be tested independently.

Set PRISM_TEST_ADMIN_DATABASE_URL to that test administrator connection, PRISM_TEST_DATABASE_URL to an existing non-owner/non-superuser test login on the same server, and PRISM_TEST_USER_ID / PRISM_TEST_SUBJECT to the test account. The administrator connection's initial database must already exist. Prepare the test login with db:runtime-role on a migrated test database or the administrator's equivalent role command. Then run:

```sh
pnpm exec tsx scripts/setup-ci-database.ts
pnpm test:postgres
pnpm verify:restore
```

setup-ci-database.ts writes only .data/test-postgres.env with mode 0600. The restore script uses pg_dump and pg_restore inside PRISM_TEST_POSTGRES_CONTAINER (default prism-test-postgres), with the fixture administrator prism_admin. Override the container name when using Docker Compose or CI. The CI workflow provides a complete example of service, role and environment setup.

Set PRISM_TEST_REDIS_URL for pnpm test to include the real Redis delivery check; otherwise that optional test is skipped. After building all three images, pnpm verify:containers checks runtime packaging in disposable containers. Its Docker Desktop defaults reach the isolated PostgreSQL host port from the test URL and Redis on host port 56379. Override PRISM_TEST_DOCKER_HOST and PRISM_TEST_CONTAINER_REDIS_URL for different test service routing. The smoke test publishes no ports and removes its own containers and scratch database; it does not validate a public TLS endpoint or real OIDC provider.

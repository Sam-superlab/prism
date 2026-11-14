import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { readFile } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createDatabase, type Database } from '@prism/database';
import { parseLiteratureConditions, pdfDisposition } from '@prism/core';
import { loadConfig, type ApiConfig } from './config';
import { PrismService, type Command } from './service';
import { ApiError, validation } from './errors';
import { arxivReference, createReferenceLookup, normalizeReferenceIdentifier, type IdentifierKind } from './reference-lookup';
import { createOpenAccessPdf, type OpenAccessPdfSelection } from './open-access-pdf';
import { createFeedPreview } from '@prism/worker';
import {
  authenticateLiteratureToken, isDeveloperLiteraturePath, isDeveloperLiteratureRead, issueLiteratureToken,
  listLiteratureTokens, readDeveloperLiterature, revokeLiteratureToken, type LiteratureCredential, type LiteratureTokenScope,
} from './developer-literature';

declare module 'fastify' {
  interface FastifyInstance {
    prism: { db: Database; config: ApiConfig; service: PrismService };
  }
  interface FastifyRequest {
    prismUser: string;
    literatureCredential?: LiteratureCredential;
  }
}
export interface BuildOptions {
  db?: Database;
  config?: ApiConfig;
  logger?: boolean;
  rateLimitMax?: number;
  feedPreview?: ReturnType<typeof createFeedPreview>;
  openAccessPdf?: ReturnType<typeof createOpenAccessPdf>;
}
const publicTeamPath = /^\/api\/v1\/team-library-discovery(?:\/[0-9a-f-]{36}(?:\/references)?)?$/i;
export async function buildApp(options: BuildOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const owned = !options.db;
  const db =
    options.db ??
    (await createDatabase({
      url: config.databaseUrl,
      dataDir: config.dataDir + '/database',
      production: config.production,
    }));
  const service = new PrismService(db, config);
  const accounts = new Map((config.hostedAccounts ?? [{ subject: config.allowedSubject, userId: config.userId }])
    .map((account) => [account.subject, account.userId]));
  const accountIds = new Set([...accounts.values()].map((id) => id.toLowerCase()));
  const developerLiteratureEnabled = config.authMode === 'oidc' && config.developerLiteratureApi;
  const lookupReference = createReferenceLookup();
  const previewFeed = options.feedPreview ?? createFeedPreview();
  const openAccessPdf = options.openAccessPdf ?? createOpenAccessPdf();
  await service.initialize();
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 1048576,
    trustProxy: false,
    genReqId: () => randomUUID(),
  });
  app.decorate('prism', { db, config, service });
  if (config.authMode !== 'desktop')
    await app.register(cors, {
      origin: config.webOrigin,
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'If-Match'],
    });
  await app.register(rateLimit, { max: options.rateLimitMax ?? 300, timeWindow: '1 minute' });
  let oidc: Record<string, string> | undefined, jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
  if (config.authMode === 'oidc') {
    if (config.production && !config.issuer?.startsWith('https://'))
      throw new Error('Production OIDC issuer must use HTTPS');
    const response = await fetch(config.issuer!.replace(/\/$/, '') + '/.well-known/openid-configuration', {
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('OIDC discovery failed');
    oidc = (await response.json()) as Record<string, string>;
    if (oidc.issuer !== config.issuer) throw new Error('OIDC issuer mismatch');
    jwks = createRemoteJWKSet(new URL(oidc.jwks_uri));
  }
  app.addHook('onRequest', async (request, reply) => {
    const pathname = request.url.split('?')[0];
    if (request.method === 'GET' && publicTeamPath.test(pathname)) {
      reply.header('Cache-Control', 'no-store');
      if (config.authMode === 'oidc' && config.hostedAccounts) return;
    }
    if (pathname.startsWith('/api/v1/') && isDeveloperLiteraturePath(pathname.slice('/api/v1'.length))) {
      reply.header('Cache-Control', 'private, no-store');
      if (!developerLiteratureEnabled) throw new ApiError(404, 'NOT_FOUND', 'Record not found');
      if (request.method === 'GET' && isDeveloperLiteratureRead(pathname)) {
        const credential = await authenticateLiteratureToken(db, request.headers.authorization);
        if (!accountIds.has(credential.userId)) throw new ApiError(401, 'UNAUTHENTICATED', 'A valid literature access token is required.');
        request.prismUser = credential.userId;
        request.literatureCredential = credential;
        return;
      }
    }
    if (config.authMode === 'desktop') {
      const { host, origin, authorization } = request.headers;
      if (
        request.ip !== '127.0.0.1' ||
        host !== `127.0.0.1:${config.port}` ||
        (origin !== undefined && origin !== config.webOrigin)
      )
        throw new ApiError(403, 'FORBIDDEN', 'Desktop requests are restricted to the local app.');
      const expected = Buffer.from(`Bearer ${config.desktopToken}`);
      const received = Buffer.from(authorization ?? '');
      if (!config.desktopToken || received.length !== expected.length || !timingSafeEqual(received, expected))
        throw new ApiError(401, 'UNAUTHENTICATED', 'Open PRISM from the desktop app.');
      request.prismUser = config.userId;
      return;
    }
    if (request.url.split('?')[0] === '/api/v1/auth/config' || request.url === '/health') return;
    if (config.authMode === 'development') {
      // Listener is forced to loopback by configuration, and requests cannot elevate the user.
      if (!['127.0.0.1', '::1', 'localhost'].includes(request.ip) && request.ip !== '::ffff:127.0.0.1')
        throw new ApiError(403, 'FORBIDDEN', 'Development authentication is loopback only');
      request.prismUser = config.userId;
      return;
    }
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to PRISM');
    try {
      const { payload } = await jwtVerify(authorization.slice(7), jwks!, {
        issuer: config.issuer,
        audience: config.audience,
        requiredClaims: ['exp', 'sub'],
      });
      const userId = payload.sub && accounts.get(payload.sub);
      if (!userId)
        throw new ApiError(403, 'FORBIDDEN', 'Account is not allowlisted');
      request.prismUser = userId;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(401, 'UNAUTHENTICATED', 'Session expired or invalid');
    }
  });
  app.setErrorHandler((error, request, reply) => {
    const e = error as any;
    let status = e instanceof ApiError ? e.status : 500,
      code = e instanceof ApiError ? e.code : 'INTERNAL_ERROR',
      message = e instanceof ApiError ? e.message : 'An unexpected server error occurred',
      details = e instanceof ApiError ? e.details : {};
    if (e.code?.startsWith('23')) {
      status = 422;
      code = 'VALIDATION_ERROR';
      message = 'Operation violates ownership, uniqueness or data constraints';
      details = { constraint: e.constraint ?? undefined };
    }
    if (e.statusCode === 413) {
      status = 413;
      code = 'VALIDATION_ERROR';
      message = 'Request exceeds 1 MiB';
    }
    if (e.statusCode === 429) {
      status = 429;
      code = 'RATE_LIMITED';
      message = 'Too many requests; retry shortly';
    }
    if (status === 500) {
      if (/^\/api\/v1\/developer\/literature(?:[/?]|$)/.test(request.url))
        request.log.error({ request_id: request.id }, 'Developer literature request failed');
      else if (/^\/api\/v1\/research\/library\/(?:feeds|feed-entries)(?:[/?]|$)/.test(request.url))
        request.log.error({ request_id: request.id }, 'Literature feed request failed');
      else if (/^\/api\/v1\/research\/(?:reference-pdfs|attachments)\/[^/]+\/(?:chunk|text-index\/pages)(?:\?|$)/.test(request.url))
        request.log.error({ request_id: request.id }, 'Attachment content request failed');
      else request.log.error({ err: error, request_id: request.id }, 'request failed');
    }
    reply.code(status).send({ error: { code, message, details, request_id: request.id } });
  });
  const spec = JSON.parse(await readFile(new URL('../../../docs/api/openapi.json', import.meta.url), 'utf8'));
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
  addFormats(ajv);
  const queryAjv = new Ajv2020({ strict: false, allErrors: true, coerceTypes: true });
  addFormats(queryAjv);
  for (const [path, operations] of Object.entries(spec.paths) as [string, any][]) {
    for (const [method, operation] of Object.entries(operations) as [string, any][]) {
      const bodySchema = operation.requestBody?.content?.['application/json']?.schema;
      const validateBody = bodySchema
        ? ajv.compile({ ...bodySchema, components: { schemas: spec.components.schemas } })
        : undefined;
      const queryParameters = operation.parameters
        .map((p: any) => (p.$ref ? spec.components.parameters[p.$ref.split('/').at(-1)] : p))
        .filter((p: any) => p.in === 'query');
      const queryProperties: Record<string, any> = {};
      for (const p of queryParameters) queryProperties[p.name] = p.schema;
      for (const name of [
        'project_id',
        'knowledge_item_id',
        'research_object_id',
        'source_item_id',
        'target_item_id',
        'session_id',
        'template_id',
        'exercise_id',
        'card_id',
      ])
        queryProperties[name] ??= { type: 'string', format: 'uuid' };
      for (const name of ['date', 'planned_date'])
        queryProperties[name] ??= { type: 'string', format: 'date' };
      for (const name of ['from', 'to', 'as_of'])
        queryProperties[name] ??= { type: 'string', format: 'date-time' };
      queryProperties.saved ??= { type: 'boolean' };
      for (const name of ['q', 'subject', 'tag', 'status'])
        queryProperties[name] ??= { type: 'string', maxLength: 300 };
      const validateQuery = queryAjv.compile({
        type: 'object',
        properties: queryProperties,
        required: queryParameters.filter((p: any) => p.required).map((p: any) => p.name),
        additionalProperties: true,
      });
      const routePath = '/api/v1' + path.replace(/\{(\w+)\}/g, ':$1');
      const openAccess = path === '/research/references/{id}/open-access' || path === '/research/references/{id}/open-access/pdf';
      app.route({
        method: method.toUpperCase() as any,
        url: routePath,
        ...((path === '/research/library/feeds/preview' || path === '/research/library/feeds/{id}/refresh') && {
          config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
        }),
        ...(openAccess && { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } }),
        handler: async (request, reply) => {
          if (openAccess || path === '/research/library/attachments' || path === '/research/library/annotations' || path.startsWith('/research/library/feed') || path.startsWith('/team-libraries'))
            reply.header('Cache-Control', 'private, no-store');
          const query = (request.query ?? {}) as Record<string, any>,
            params = (request.params ?? {}) as Record<string, string>;
          const attachmentChunk = path === '/research/attachments/{id}/chunk' || path === '/research/reference-pdfs/{id}/chunk';
          if (!validateQuery(query))
            throw validation('Invalid query parameters', { errors: validateQuery.errors });
          for (const p of operation.parameters.filter((x: any) => x.in === 'path'))
            if (
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                params[p.name] ?? '',
              )
            )
              throw validation('Invalid UUID path parameter');
          if (
            path === '/research/library/search' ||
            path === '/research/library/saved-searches' ||
            path === '/research/library/saved-searches/{id}'
          ) {
            const body = request.body as { conditions?: unknown } | undefined;
            // Bound nesting before the recursive JSON schema visits the condition tree.
            if (body?.conditions != null) parseLiteratureConditions(body.conditions);
          }
          if (validateBody && !validateBody(request.body)) {
            if (attachmentChunk) throw validation('Invalid attachment chunk.');
            if (path === '/research/reference-pdfs/{id}/text-index/pages' ||
                path === '/research/attachments/{id}/text-index/pages')
              throw validation('Invalid text index pages.');
            throw validation('Invalid request body', { errors: validateBody.errors });
          }
          const requestPath = path.replace(/\{(\w+)\}/g, (_, name) => params[name]);
          if (isDeveloperLiteraturePath(path)) {
            if (request.literatureCredential && method === 'get')
              return readDeveloperLiterature(db, request.literatureCredential, config.secret, requestPath, query);
            if (path === '/developer/literature/tokens' && method === 'get') return listLiteratureTokens(db, request.prismUser);
            if (path === '/developer/literature/tokens' && method === 'post') {
              const token = await issueLiteratureToken(db, request.prismUser, request.body as { id: string; name: string; expires_in_days: number; scope?: LiteratureTokenScope });
              return reply.code(201).send(token);
            }
            if (path === '/developer/literature/tokens/{id}' && method === 'delete') {
              await revokeLiteratureToken(db, request.prismUser, params.id);
              return reply.code(204).send();
            }
            throw new ApiError(401, 'UNAUTHENTICATED', 'A valid literature access token is required.');
          }
          if (openAccess) {
            const reference = await service.query(request.prismUser, `research/references/${params.id}`);
            if (method === 'get') return openAccessPdf.discover(reference);
            const file = await openAccessPdf.download(reference, request.body as OpenAccessPdfSelection);
            return reply.header('Content-Disposition', pdfDisposition(file.fileName))
              .header('Cross-Origin-Resource-Policy', 'same-origin')
              .header('X-Content-Type-Options', 'nosniff')
              .header('Content-Security-Policy', 'sandbox')
              .type('application/pdf').send(file.bytes);
          }
          if (path === '/auth/config') {
            if (!oidc)
              throw new ApiError(
                422,
                'VALIDATION_ERROR',
                'OIDC is not configured in explicit local development mode',
              );
            return {
              issuer: config.issuer,
              authorization_endpoint: oidc.authorization_endpoint,
              token_endpoint: oidc.token_endpoint,
              mobile_client_id: config.mobileClientId ?? '',
              mobile_redirect_uri: config.mobileRedirectUri,
              scopes: ['openid', 'profile', 'email', 'offline_access'],
            };
          }
          if (method === 'get') {
            if (path === '/team-libraries/{library_id}/references/{reference_id}/attachments/{id}/download') {
              const file = await service.downloadTeamLibraryAttachment(request.prismUser, params.library_id, params.reference_id, params.id);
              return reply.header('Content-Disposition', pdfDisposition(file.fileName))
                .header('Cross-Origin-Resource-Policy', 'same-origin')
                .header('X-Content-Type-Options', 'nosniff')
                .header('Content-Security-Policy', 'sandbox')
                .type('application/pdf').send(file.bytes);
            }
            if (path === '/research/library/lookup') {
              const kind = query.kind as IdentifierKind;
              const identifier = normalizeReferenceIdentifier(kind, query.value);
              reply.header('Cache-Control', 'private, no-store');
              if (kind === 'arxiv') {
                const base = identifier.replace(/v[1-9][0-9]*$/, '');
                const { rows } = await service.read(request.prismUser, (sql) => sql.query<{
                  arxiv_id: string; latest_version: number; title: string; authors: string[];
                  abstract: string; published_at: string;
                }>(
                  `SELECT arxiv_id,latest_version,title,authors,abstract,published_at::text
                   FROM arxiv_papers WHERE arxiv_id=$1`,
                  [base],
                ));
                const reference = rows[0] && arxivReference(rows[0], identifier);
                if (reference?.title) return { kind, identifier, reference };
              }
              return lookupReference(kind, identifier);
            }
            if (path === '/research/reference-pdfs/{id}/download' || path === '/research/attachments/{id}/download') {
              const onlyFormat = path === '/research/reference-pdfs/{id}/download' ? 'pdf' : undefined;
              const attachment = await service.downloadReferenceAttachment(request.prismUser, params.id, onlyFormat);
              return reply
                .header('Content-Disposition', pdfDisposition(attachment.fileName))
                .header('Cache-Control', 'private, no-store')
                .header('Cross-Origin-Resource-Policy', 'same-origin')
                .header('X-Content-Type-Options', 'nosniff')
                .header('Content-Security-Policy', 'sandbox')
                .type({
                  pdf: 'application/pdf',
                  epub: 'application/epub+zip',
                  webpage: 'text/plain; charset=utf-8',
                }[attachment.format])
                .send(attachment.bytes);
            }
            if (path === '/exports/{id}/download') {
              const bytes = await service.downloadExport(request.prismUser, params.id);
              return reply
                .header('Content-Disposition', `attachment; filename="prism-${params.id}.zip"`)
                .type('application/zip')
                .send(Buffer.from(bytes));
            }
            const result = await service.query(request.prismUser, requestPath, query);
            if (result?.version) reply.header('ETag', `"${result.version}"`);
            return result;
          }
          if (path === '/research/library/search') {
            reply.header('Cache-Control', 'private, no-store');
            return service.searchLiterature(request.prismUser, request.body as Record<string, unknown>);
          }
          if (path === '/research/library/feeds/preview') {
            return previewFeed((request.body as { url: string }).url);
          }
          const key = String(request.headers['idempotency-key'] ?? '');
          const requiresMatch = operation.parameters.some(
            (p: any) => p.$ref === '#/components/parameters/IfMatch',
          );
          const match = request.headers['if-match'];
          let expected: string | undefined;
          if (requiresMatch) {
            const m = typeof match === 'string' ? /^"([1-9][0-9]*)"$/.exec(match) : null;
            if (!m) throw new ApiError(428, 'PRECONDITION_REQUIRED', 'A quoted If-Match version is required');
            expected = m[1];
          }
          if (attachmentChunk) {
            const onlyFormat = path === '/research/reference-pdfs/{id}/chunk' ? 'pdf' : undefined;
            return service.uploadReferenceAttachmentChunk(
              request.prismUser, key, params.id, request.body as Record<string, unknown>, onlyFormat,
            );
          }
          if (path === '/sync/push') {
            const result = await service.pushBatch(request.prismUser, key, request.body as any);
            return result;
          }
          if (path === '/today/review-drafts') {
            const body = request.body as { date: string; retry?: boolean };
            return service.generateDailyReviewDrafts(request.prismUser, key, body);
          }
          const command: Command = {
            userId: request.prismUser,
            key,
            method: method.toUpperCase(),
            path: requestPath.replace(/^\//, ''),
            body: (request.body ?? {}) as any,
            expected,
            dependsOn: (request.body as any)?.depends_on_operation_id,
          };
          const result = path === '/research/library/feeds/{id}/refresh'
            ? await service.refreshLiteratureFeed(command, params.id, previewFeed)
            : await service.execute(command);
          if (result.body?.error) result.body.error.request_id = request.id;
          if (result.body?.version) reply.header('ETag', `"${result.body.version}"`);
          reply.code(result.status);
          return result.status === 204 ? reply.send() : result.body;
        },
      });
    }
  }
  app.get('/health', async () => ({ status: 'ok', database: db.kind, auth_mode: config.authMode }));
  app.addHook('onClose', async () => {
    if (owned) await db.close();
  });
  return app;
}

import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '@prism/database';
import { loadConfig, type ApiConfig } from './config';
import { PrismService, type Command } from './service';
import { ApiError, validation } from './errors';

declare module 'fastify' {
  interface FastifyInstance {
    prism: { db: Database; config: ApiConfig; service: PrismService };
  }
  interface FastifyRequest {
    prismUser: string;
  }
}
export interface BuildOptions {
  db?: Database;
  config?: ApiConfig;
  logger?: boolean;
}
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
  await service.initialize();
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 1048576,
    trustProxy: false,
    genReqId: () => randomUUID(),
  });
  app.decorate('prism', { db, config, service });
  await app.register(cors, {
    origin: config.webOrigin,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'If-Match'],
  });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
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
  app.addHook('onRequest', async (request) => {
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
      if (payload.sub !== config.allowedSubject)
        throw new ApiError(403, 'FORBIDDEN', 'Account is not allowlisted');
      request.prismUser = config.userId;
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
    if (status === 500) request.log.error({ err: error, request_id: request.id }, 'request failed');
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
      app.route({
        method: method.toUpperCase() as any,
        url: routePath,
        handler: async (request, reply) => {
          const query = (request.query ?? {}) as Record<string, any>,
            params = (request.params ?? {}) as Record<string, string>;
          if (!validateQuery(query))
            throw validation('Invalid query parameters', { errors: validateQuery.errors });
          for (const p of operation.parameters.filter((x: any) => x.in === 'path'))
            if (
              !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                params[p.name] ?? '',
              )
            )
              throw validation('Invalid UUID path parameter');
          if (validateBody && !validateBody(request.body))
            throw validation('Invalid request body', { errors: validateBody.errors });
          const requestPath = path.replace(/\{(\w+)\}/g, (_, name) => params[name]);
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
          if (path === '/sync/push') {
            const result = await service.pushBatch(request.prismUser, key, request.body as any);
            return result;
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
          const result = await service.execute(command);
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

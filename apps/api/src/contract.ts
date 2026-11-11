import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
let specPromise: Promise<any> | undefined;
const cache = new Map<string, ReturnType<Ajv2020['compile']>>();
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
/** Test-only response contract check. Production responses are explicit service projections. */
export async function validateApiResponse(
  method: string,
  path: string,
  status: number,
  body: any,
): Promise<string[]> {
  specPromise ??= readFile(new URL('../../../docs/api/openapi.json', import.meta.url), 'utf8').then(
    JSON.parse,
  );
  const spec = await specPromise;
  const pathname = new URL(path, 'http://prism.local').pathname;
  const pattern = Object.keys(spec.paths).find((p) =>
    new RegExp('^' + p.replace(/\{\w+\}/g, '[^/]+') + '$').test(pathname),
  );
  if (!pattern) return ['No matching contract operation'];
  const operation = spec.paths[pattern][method.toLowerCase()];
  if (!operation) return ['No matching contract method'];
  let response = operation.responses[String(status)] ?? operation.responses.default;
  if (response?.$ref) response = spec.components.responses[response.$ref.split('/').at(-1)];
  const schema = response?.content?.['application/json']?.schema;
  if (!schema) return [];
  const key = method + pattern + status;
  let validate = cache.get(key);
  if (!validate) {
    validate = ajv.compile({ ...schema, components: { schemas: spec.components.schemas } });
    cache.set(key, validate);
  }
  return validate(body) ? [] : (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
}

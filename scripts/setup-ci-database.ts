import { mkdir, writeFile } from 'node:fs/promises';
const names = [
  'PRISM_TEST_DATABASE_URL',
  'PRISM_TEST_ADMIN_DATABASE_URL',
  'PRISM_TEST_USER_ID',
  'PRISM_TEST_SUBJECT',
];
for (const name of names)
  if (!process.env[name]) throw new Error(`${name} is required for isolated CI database tests`);
await mkdir('.data', { recursive: true });
await writeFile(
  '.data/test-postgres.env',
  names.map((name) => `${name}=${process.env[name]}`).join('\n') + '\n',
  { mode: 0o600 },
);
console.log('Configured isolated test-database connections.');

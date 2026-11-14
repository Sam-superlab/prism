import { createHash, randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const source = new URL('https://encyclopediaofmath.org/api.php');
source.search = new URLSearchParams({
  action: 'query',
  list: 'allpages',
  apnamespace: '0',
  apfilterredir: 'nonredirects',
  aplimit: 'max',
  format: 'json',
  formatversion: '2',
  maxlag: '5',
});
const destination = new URL('../packages/core/src/arxiv-eom-titles.json', import.meta.url);
const titleIndex = new Set();
const continuations = new Set();
const navigation = new Set(['Main Page', 'Editorial Board', 'Editorial Policy']);
const maxPages = 100;

async function fetchTitleIndex() {
  const page = new URL(source);
  for (let request = 1; request <= maxPages; request++) {
    const response = await fetch(page, {
      headers: { accept: 'application/json', 'user-agent': 'PRISM/1.0 (manual EoM title index refresh)' },
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`EoM API returned HTTP ${response.status}`);
    const data = await response.json();
    if (data?.error) throw new Error(`EoM API returned ${data.error.code}`);
    if (data?.warnings || !Array.isArray(data?.query?.allpages)) throw new Error('Invalid EoM API response');
    for (const row of data.query.allpages) {
      if (row?.ns !== 0 || typeof row.title !== 'string' || !row.title.trim() || /\p{Cc}/u.test(row.title)) {
        throw new Error('Invalid article title in EoM API response');
      }
      const title = row.title.trim().normalize('NFC');
      if (!navigation.has(title) && !/\/Fig\d+$/i.test(title)) titleIndex.add(title);
    }

    const cursor = data.continue;
    if (cursor === undefined) {
      // Reject implausibly small results instead of replacing a usable catalog with a partial response.
      if (data.batchcomplete !== true || titleIndex.size < 5000)
        throw new Error('Incomplete EoM title index');
      return [...titleIndex].sort();
    }
    if (
      typeof cursor?.continue !== 'string' ||
      typeof cursor.apcontinue !== 'string' ||
      !cursor.apcontinue ||
      continuations.has(cursor.apcontinue)
    ) {
      throw new Error('Invalid or repeated EoM pagination cursor');
    }
    continuations.add(cursor.apcontinue);
    page.searchParams.set('continue', cursor.continue);
    page.searchParams.set('apcontinue', cursor.apcontinue);
    await delay(750);
  }
  throw new Error('EoM title index exceeded the pagination limit');
}

try {
  const titles = await fetchTitleIndex();
  const output = `${JSON.stringify(titles, null, 2)}\n`;
  const temporary = new URL(`${destination.href}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, output, { flag: 'wx' });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  console.log(`Saved ${titles.length} EoM article titles from ${source.href}`);
  console.log(`SHA-256 ${createHash('sha256').update(output).digest('hex')}`);
} catch (error) {
  console.error(`EoM title refresh failed. ${error.message}`);
  process.exitCode = 1;
}

import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

export const macUpdateHost = '127.0.0.1';
export const macUpdatePort = 38743;

const zipPath = /^\/PRISM-personal-[1-9][0-9]*\.zip$/;
const statOptions = { bigint: true };
const responseHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const sameEntry = (before, after) => before.dev === after.dev && before.ino === after.ino;

export function createMacUpdateServer(root) {
  const data = join(root, '.data');
  const updates = join(data, 'macos-updates');

  return createServer(async (request, response) => {
    if (
      request.headersDistinct.host?.length !== 1 ||
      request.headers.host !== `${macUpdateHost}:${macUpdatePort}`
    ) {
      response.writeHead(403, responseHeaders).end();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { ...responseHeaders, Allow: 'GET, HEAD' }).end();
      return;
    }
    const url = request.url ?? '';
    const contentType = url === '/appcast.xml' ? 'application/rss+xml; charset=utf-8' : 'application/zip';
    if (url !== '/appcast.xml' && !zipPath.test(url)) {
      response.writeHead(404, responseHeaders).end();
      return;
    }

    const path = join(updates, url.slice(1));
    let file;
    try {
      const parents = await Promise.all([lstat(data, statOptions), lstat(updates, statOptions)]);
      if (!parents.every((stat) => stat.isDirectory())) {
        response.writeHead(404, responseHeaders).end();
        return;
      }
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const [opened, asset, currentData, currentUpdates] = await Promise.all([
        file.stat(statOptions),
        lstat(path, statOptions),
        lstat(data, statOptions),
        lstat(updates, statOptions),
      ]);
      // Serve the opened file only if it is still the direct entry under both original directories.
      if (
        !opened.isFile() ||
        opened.nlink !== 1n ||
        !asset.isFile() ||
        !sameEntry(opened, asset) ||
        !sameEntry(parents[0], currentData) ||
        !sameEntry(parents[1], currentUpdates)
      ) {
        response.writeHead(404, responseHeaders).end();
        return;
      }
      response.writeHead(200, {
        ...responseHeaders,
        'Content-Type': contentType,
        'Content-Length': opened.size.toString(),
      });
      if (request.method === 'HEAD') response.end();
      else await pipeline(file.createReadStream({ autoClose: false }), response);
    } catch {
      if (response.headersSent) response.destroy();
      else response.writeHead(404, responseHeaders).end();
    } finally {
      await file?.close().catch(() => {});
    }
  });
}

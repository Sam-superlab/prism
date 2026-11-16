import assert from 'node:assert/strict';
import { open, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const [app, fixturePath] = process.argv.slice(2);
assert.equal(process.platform, 'win32', 'Run this script on native Windows');
assert.equal(process.arch, 'x64', 'Run with bundled Windows x64 Node');
assert.ok(isAbsolute(app) && isAbsolute(fixturePath), 'Use absolute paths');
const appBinary = resolve(app, 'PRISM.exe');
const bundledNode = resolve(app, 'resources/runtime/node.exe');
assert.equal((await realpath(process.execPath)).toLowerCase(), (await realpath(bundledNode)).toLowerCase());
const modelRoot = resolve(app, 'resources/desktop/discover-scorer');
const native = join(modelRoot, 'node_modules/onnxruntime-node/bin/napi-v6/win32/x64/onnxruntime_binding.node');
for (const binary of [appBinary, bundledNode, native]) {
  const file = await open(binary);
  try {
    const magic = Buffer.alloc(2);
    assert.equal((await file.read(magic, 0, 2, 0)).bytesRead, 2);
    assert.equal(magic.toString('ascii'), 'MZ');
  } finally {
    await file.close();
  }
}
const { createDiscoverScorerProcess } = await import(pathToFileURL(join(modelRoot, 'prism-cross-encoder-process.mjs')).href);
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
assert.equal(fixture.papers.length, 6);
assert.equal(fixture.expectedLogits.length, fixture.papers.length);
assert.ok(fixture.papers.every(({ id, url }) => url === 'https://arxiv.org/abs/' + id));
const texts = fixture.papers.map(({ title, abstract }) => title + '\n' + abstract.slice(0, 5000));
const scorer = createDiscoverScorerProcess();
try {
  const scores = await scorer.score(fixture.query, texts, 'paper');
  assert.equal(scores.length, fixture.expectedLogits.length);
  for (const [index, score] of scores.entries()) {
    assert.ok(Number.isFinite(score) && Math.abs(score - fixture.expectedLogits[index]) < 0.005,
      'Windows native logits differ from the golden public arXiv fixture');
  }
  const rank = (logits) => logits.map((value, index) => ({ value, index }))
    .sort((left, right) => right.value - left.value).map(({ index }) => fixture.papers[index].id);
  assert.deepEqual(rank(scores), rank(fixture.expectedLogits));
  console.log(JSON.stringify({
    scorer: 'Windows x64 native MiniLM CPU with bundled node.exe',
    papers: scores.length, rankedArxivIds: rank(scores),
    maximumAbsoluteLogitDelta: Math.max(...scores.map((value, index) => Math.abs(value - fixture.expectedLogits[index]))),
  }));
} finally {
  await scorer.close();
}

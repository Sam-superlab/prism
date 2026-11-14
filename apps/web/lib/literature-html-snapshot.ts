export const maxSnapshotHtmlBytes = 8 * 1024 * 1024;
const maxSnapshotTextLength = 60_000;
const maxSnapshotParagraphs = 2_000;

const omitted = new Set([
  'head', 'title', 'meta', 'base', 'link', 'script', 'style', 'template', 'noscript',
  'iframe', 'frame', 'frameset', 'object', 'embed', 'canvas', 'svg', 'audio', 'video', 'source',
  'form', 'input', 'select', 'option', 'textarea', 'button', 'datalist', 'output', 'dialog',
]);
const blocks = new Set([
  'address', 'article', 'aside', 'blockquote', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'li', 'main', 'nav', 'p', 'pre', 'section', 'tr',
]);

function clean(text: string) {
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '').replace(/\s+/g, ' ').trim();
}

function clipped(text: string, length: number) {
  return text.slice(0, length).replace(/[\uD800-\uDBFF]$/, '');
}

export async function extractLiteratureHtmlSnapshot(source: File) {
  if (!source.size || source.size > maxSnapshotHtmlBytes) throw new Error('HTML snapshots must be no larger than 8 MiB.');
  let html: string;
  try { html = new TextDecoder('utf-8', { fatal: true }).decode(await source.arrayBuffer()); }
  catch { throw new Error('Choose an HTML snapshot encoded as UTF-8.'); }

  // A template parses in its inert contents document. Keep it detached and read
  // only text. DOMParser's HTML document can fetch some subresources on parse.
  const template = document.createElement('template');
  template.innerHTML = html;
  const rawTitle = clean(template.content.querySelector('title')?.textContent ?? '');
  const title = clipped(rawTitle, 300);
  const paragraphs: string[] = [];
  let size = title.length;
  let pending = '';
  let truncated = rawTitle.length > title.length;
  let full = false;
  let visited = 0;

  function flush() {
    const paragraph = clean(pending);
    pending = '';
    if (!paragraph) return;
    const separator = size ? 2 : 0;
    const remaining = maxSnapshotTextLength - size - separator;
    if (paragraphs.length + Number(Boolean(title)) >= maxSnapshotParagraphs || remaining <= 0) {
      truncated = full = true;
      return;
    }
    const next = clipped(paragraph, remaining);
    if (next) {
      paragraphs.push(next);
      size += next.length + separator;
    }
    if (paragraph.length > next.length) truncated = full = true;
  }

  type Step = { node: Node; exit?: boolean };
  const stack: Step[] = [{ node: template.content }];
  while (stack.length && !full) {
    const { node, exit } = stack.pop()!;
    if (exit) { flush(); continue; }
    if (++visited > 100_000) { truncated = true; break; }
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? '';
      // Bound even very long unbroken text nodes before keeping a paragraph.
      pending += text;
      if (pending.length > maxSnapshotTextLength * 2) flush();
      continue;
    }
    if (node instanceof Element) {
      const name = node.localName.toLowerCase();
      if (omitted.has(name) || node.hasAttribute('hidden') || node.getAttribute('aria-hidden')?.toLowerCase() === 'true' ||
          /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/i.test(node.getAttribute('style') ?? '')) continue;
      if (name === 'br' || name === 'hr') { flush(); continue; }
      if (name === 'td' || name === 'th') pending += ' ';
      if (blocks.has(name)) {
        flush();
        stack.push({ node, exit: true });
      }
    } else if (node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) continue;
    for (let child = node.lastChild; child; child = child.previousSibling) stack.push({ node: child });
  }
  flush();
  if (!paragraphs.length) throw new Error('This HTML snapshot has no readable page text.');
  const text = [title, ...paragraphs].filter(Boolean).join('\n\n');
  const file = new File([text], source.name.replace(/\.html?$/i, '.txt'), { type: 'text/plain' });
  return { file, title, excerpt: clipped(paragraphs[0], 240), truncated };
}

import type { MarkdownConfig } from '@lezer/markdown';

const dollar = '$'.charCodeAt(0);
const backslash = '\\'.charCodeAt(0);
const newline = '\n'.charCodeAt(0);
const fence = /^(\${2,})[ \t]*$/;

export const liveMarkdownMath: MarkdownConfig = {
  defineNodes: ['InlineMath', { name: 'DisplayMath', block: true }, { name: 'UnclosedMath', block: true }],
  parseInline: [{
    name: 'InlineMath',
    after: 'InlineCode',
    parse(context, next, from) {
      if (next !== dollar) return -1;

      // Don't start a new formula in the middle of a delimiter run.
      if (context.char(from - 1) === dollar) {
        let before = from - 2;
        while (context.char(before) === backslash) before--;
        if ((from - 2 - before) % 2 === 0) return -1;
      }

      let start = from + 1;
      while (context.char(start) === dollar) start++;
      const size = start - from;
      if (size === 1 && /\s/.test(context.slice(start, start + 1))) return -1;
      for (let pos = start; pos < context.end;) {
        const char = context.char(pos);
        if (char === newline) break;
        const following = context.char(pos + 1);
        if (char === backslash && (following === backslash || following === dollar)) {
          pos += 2;
          continue;
        }
        if (char !== dollar) {
          pos++;
          continue;
        }

        let end = pos + 1;
        while (context.char(end) === dollar) end++;
        if (end - pos !== size) {
          pos = end;
          continue;
        }

        const body = context.slice(start, pos);
        if (!body.trim()) return -1;
        // A closing dollar before another price stays part of ordinary prose.
        if (size === 1 && (/\s$/.test(body) || /\d/.test(context.slice(end, end + 1)))) return -1;
        return context.addElement(context.elt(size === 1 ? 'InlineMath' : 'DisplayMath', from, end));
      }
      return -1;
    },
  }],
  parseBlock: [{
    name: 'DisplayMath',
    after: 'IndentedCode',
    endLeaf(context, line) {
      return context.depth === 1 && fence.test(line.text.slice(line.pos));
    },
    parse(context, line) {
      // A nested formula is left in source form to preserve list/quote markup.
      if (context.depth !== 1) return false;
      const opener = fence.exec(line.text.slice(line.pos));
      if (!opener) return false;

      const from = context.lineStart + line.pos;
      while (context.nextLine()) {
        const closer = fence.exec(line.text.slice(line.pos));
        if (closer && closer[1].length >= opener[1].length && line.indent - line.baseIndent < 4) {
          const to = context.lineStart + line.pos + closer[1].length;
          context.addElement(context.elt('DisplayMath', from, to));
          context.nextLine();
          return true;
        }
      }

      context.addElement(context.elt('UnclosedMath', from, context.prevLineEnd()));
      return true;
    },
  }],
};

export function readLiveMath(source: string, display: boolean): string {
  if (!display) return source.slice(1, -1).trim();
  const firstBreak = source.indexOf('\n');
  if (firstBreak !== -1) return source.slice(firstBreak + 1, source.lastIndexOf('\n')).trim();
  const size = /^\$+/.exec(source)?.[0].length ?? 0;
  return source.slice(size, -size).trim();
}

import type { Row } from '@prism/database';
import { validation } from './errors';

export function validatePdfAnnotation(body: Row, previous?: Row) {
  if (body.tags) {
    const tags = new Map<string, string>();
    for (const raw of body.tags as string[]) {
      const tag = raw.trim();
      if (tag && !tags.has(tag.toLowerCase())) tags.set(tag.toLowerCase(), tag);
    }
    body.tags = [...tags.values()];
  }
  const kind = body.kind ?? previous?.kind;
  if (kind === 'note') {
    if ((body.rects ?? previous?.rects)?.length !== 1)
      throw validation('Place the note at a single point on the page.');
    if (!(body.comment ?? previous?.comment)?.trim())
      throw validation('Enter a comment for this note.');
  }
  if (kind === 'area' && (body.rects ?? previous?.rects)?.length !== 1)
    throw validation('Select one area on the PDF page.');
  const rects = body.rects ?? previous?.rects;
  if (kind === 'ink') {
    const points = body.ink_path ?? previous?.ink_path;
    if (!points || points.length < 2 || rects?.length !== 1)
      throw validation('Draw a stroke on the PDF page.');
    const [bounds] = rects;
    if (!points.some((point: Row) => point.x !== points[0].x || point.y !== points[0].y) ||
      points.some((point: Row) => point.x < bounds.x - 0.000001 || point.y < bounds.y - 0.000001 ||
        point.x > bounds.x + bounds.width + 0.000001 || point.y > bounds.y + bounds.height + 0.000001))
      throw validation('The ink stroke must stay within its page rectangle.');
  } else if (body.ink_path !== undefined) {
    throw validation('Ink paths belong to ink annotations.');
  } else if (previous?.kind === 'ink') body.ink_path = null;
  if (!body.rects) return;
  for (const rect of body.rects) {
    if (rect.x + rect.width > 1.000001 || rect.y + rect.height > 1.000001)
      throw validation('Annotation rectangles must be contained within the PDF page.');
    rect.width = Math.min(rect.width, 1 - rect.x);
    rect.height = Math.min(rect.height, 1 - rect.y);
    if (rect.width <= 0 || rect.height <= 0)
      throw validation('Annotation rectangles must have a positive area.');
  }
}

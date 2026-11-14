const staticImage = /^\/knowledge-sources\/(?:[\w-]+\/)*[\w-]+\.(?:png|jpe?g|webp|gif|avif)$/i;
const areaSource = /^\/research\/library\?reference=([\da-f-]{36})&pdf=([\da-f-]{36})&page=([1-9]\d{0,5})&annotation=([\da-f-]{36})$/;
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/;

export function pdfAreaImageSource(src: string) {
  const [, referenceId, pdfId, page, annotationId] = areaSource.exec(src) ?? [];
  if (!referenceId || ![referenceId, pdfId, annotationId].every((id) => uuid.test(id))) return;
  return { pdfId, page: Number(page), annotationId };
}

export function isKnowledgeImageSource(src: string) {
  return staticImage.test(src) || Boolean(pdfAreaImageSource(src));
}

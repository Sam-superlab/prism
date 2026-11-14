const base = 'https://prism.invalid';
const library = '/research/library';
const publicLibraries = '/team-library-discovery';
const identifier = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

export function authReturnPath(value: unknown): string {
  if (typeof value !== 'string' || value.length > 1000 || /[\\#\s\x00-\x1f\x7f]/u.test(value))
    return '/today';
  if (value === publicLibraries || value.startsWith(publicLibraries + '?')) {
    const url = new URL(value, base);
    const id = url.searchParams.get('library');
    return id && identifier.test(id) ? `${publicLibraries}?library=${id}` : publicLibraries;
  }
  if (value !== library && !value.startsWith(library + '?')) return '/today';
  const url = new URL(value, base);
  if (url.origin !== base || url.pathname !== library) return '/today';

  const reference = url.searchParams.get('reference');
  const pdf = url.searchParams.get('pdf');
  const page = url.searchParams.get('page');
  const annotation = url.searchParams.get('annotation');
  const target = new URL(library, base);
  if (reference && identifier.test(reference)) {
    target.searchParams.set('reference', reference);
    if (pdf && identifier.test(pdf)) {
      target.searchParams.set('pdf', pdf);
      if (page && /^[1-9]\d{0,5}$/.test(page)) target.searchParams.set('page', page);
      if (annotation && identifier.test(annotation)) target.searchParams.set('annotation', annotation);
      if (url.searchParams.get('view') === 'reader') target.searchParams.set('view', 'reader');
    }
  }
  return target.pathname + target.search;
}

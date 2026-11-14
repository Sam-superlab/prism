export type CustomLiteratureCitationStyle = { id: string; label: string; xml: string };

const namespace = 'http://purl.org/net/xbiblio/csl';
export const customCitationStyleMaxBytes = 250_000;
export const customCitationStyleLimit = 5;

function validateMacros(root: Element) {
  const macros = new Map<string, string[]>();
  const references = (node: Element) =>
    Array.from(node.querySelectorAll('[macro]'), (element) => element.getAttribute('macro')!);
  for (const macro of Array.from(root.children).filter((node) => node.localName === 'macro')) {
    const name = macro.getAttribute('name');
    if (!name || macros.has(name))
      throw new Error('The citation style has a missing or repeated macro name.');
    macros.set(name, references(macro));
  }
  const sizes = new Map<string, number>();
  const active = new Set<string>();
  const maximumExpansion = 20_000;
  function expansion(name: string): number {
    const cached = sizes.get(name);
    if (cached !== undefined) return cached;
    if (active.has(name)) throw new Error('The citation style contains a circular macro reference.');
    const dependencies = macros.get(name);
    if (!dependencies) throw new Error('The citation style refers to a missing macro.');
    if (active.size >= 32) throw new Error('The citation style has too many nested macros.');
    active.add(name);
    let total = 1;
    for (const dependency of dependencies) {
      total += expansion(dependency);
      if (total > maximumExpansion) throw new Error('The citation style expands too many macros.');
    }
    active.delete(name);
    sizes.set(name, total);
    return total;
  }
  let total = 0;
  for (const name of references(root)) {
    total += expansion(name);
    if (total > maximumExpansion) throw new Error('The citation style expands too many macros.');
  }
}

export function validateCustomCitationStyle(input: string): { label: string; xml: string } {
  if (new TextEncoder().encode(input).byteLength > customCitationStyleMaxBytes)
    throw new Error('Choose a citation style under 250 KB.');
  const xml = input.replace(/^\uFEFF/, '').trim();
  const declaration = /^<\?xml(?:\s[^?]*)?\?>/i;
  if (/<!\s*(?:doctype|entity)|<\?/i.test(xml.replace(declaration, '')))
    throw new Error('The citation style contains an XML declaration or instruction that is not supported.');

  // Parse an inert XML document. Only standard CSL nodes are accepted, so
  // imported files cannot add HTML, XInclude or any external processing.
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  const root = document.documentElement;
  if (
    document.doctype ||
    !root ||
    root.localName !== 'style' ||
    root.namespaceURI !== namespace ||
    document.getElementsByTagName('parsererror').length > 0
  )
    throw new Error('Choose a valid Citation Style Language (.csl) file.');
  const nodes = Array.from(root.querySelectorAll('*'));
  if (nodes.length > 5000 || nodes.some((node) => node.namespaceURI !== namespace || node.prefix))
    throw new Error('The citation style is too complex or contains unsupported XML elements.');
  if (root.prefix) throw new Error('Choose an unprefixed Citation Style Language (.csl) file.');
  for (const node of nodes) {
    let depth = 0;
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      if (++depth > 64) throw new Error('The citation style has too many nested XML elements.');
    }
  }

  const info = Array.from(root.children).find((node) => node.localName === 'info');
  const label = info?.getElementsByTagNameNS(namespace, 'title')[0]?.textContent?.replace(/\s+/g, ' ').trim();
  if (!label) throw new Error('The citation style does not have a title.');
  if (info?.querySelector('link[rel="independent-parent"]'))
    throw new Error('This style depends on a parent style. Choose its independent .csl file instead.');
  const hasLayout = (section: string) =>
    Array.from(root.children).some(
      (node) =>
        node.localName === section && Array.from(node.children).some((child) => child.localName === 'layout'),
    );
  if (!hasLayout('citation') || !hasLayout('bibliography'))
    throw new Error('Choose an independent style that defines a citation and bibliography layout.');
  validateMacros(root);
  return { label: label.slice(0, 160), xml };
}

export function readCustomCitationStyles(storage: Pick<Storage, 'getItem'>): CustomLiteratureCitationStyle[] {
  try {
    const raw = storage.getItem('prism.literature.csl-styles.v1');
    if (!raw || raw.length > customCitationStyleMaxBytes * customCitationStyleLimit * 2) return [];
    const saved: unknown = JSON.parse(raw);
    if (!Array.isArray(saved)) return [];
    const styles: CustomLiteratureCitationStyle[] = [];
    for (const entry of saved.slice(0, customCitationStyleLimit)) {
      if (
        !entry ||
        !/^custom-[a-f\d-]{36}$/i.test(entry.id) ||
        typeof entry.xml !== 'string' ||
        styles.some(({ id }) => id === entry.id)
      )
        continue;
      try {
        styles.push({ id: entry.id, ...validateCustomCitationStyle(entry.xml) });
      } catch {
        // Ignore a malformed saved style and preserve the remaining valid styles.
      }
    }
    return styles;
  } catch {
    return [];
  }
}

export function saveCustomCitationStyles(
  storage: Pick<Storage, 'setItem'>,
  styles: readonly CustomLiteratureCitationStyle[],
) {
  storage.setItem('prism.literature.csl-styles.v1', JSON.stringify(styles));
}

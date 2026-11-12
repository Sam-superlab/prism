import { arxivMathTerms } from './arxiv-math-terms';
import eomTitles from './arxiv-eom-titles.json';

export interface ArxivDeckCandidate {
  paper_id: string;
  title: string;
  abstract: string;
  categories: string[];
  updated_at: string;
  subscription_score: number;
}

export interface ArxivDeckFeedback {
  paper_id: string;
  title: string;
  abstract: string;
  reaction: 'interested' | 'liked' | 'not_interested' | 'skip' | null;
  is_saved: boolean;
  updated_at: string;
}

export interface ArxivDeckKeyword {
  term: string;
  mode: 'follow' | 'less';
}

export interface ArxivResearchContext {
  project_title: string;
  headings: string[];
  excerpts: string[];
  paper_id: string | null;
}

interface DeckInput {
  candidates: readonly ArxivDeckCandidate[];
  feedback: readonly ArxivDeckFeedback[];
  keywords: readonly ArxivDeckKeyword[];
  research?: readonly ArxivResearchContext[];
  now: Date | string | number;
  seed: string | number;
}

const day = 86_400_000;
const stopWords = new Set(
  (
    'about after all also among and another are based been being both can could each first for from ' +
    'general give given has have how into its may more most new note now one only other our over paper ' +
    'present prove proposed provide recent result results same second several show some study such ' +
    'than that the their them then there these they this those through two under use used using was ' +
    'were what when where which while who will with without work would'
  ).split(' '),
);
// These encyclopedia titles have many ordinary uses outside their mathematical sense.
const broadKeywords = new Set(
  (
    'category class degree factor field form function group law limit map method model module number order ' +
    'point power problem product ring sequence series set space structure surface system theory type'
  ).split(' '),
);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function words(text: string): string[] {
  return (
    text
      .normalize('NFKC')
      .toLowerCase()
      .replace(/\\[a-z]+/g, ' ')
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

function meaningful(word: string) {
  return word.length >= 3 && /\p{L}/u.test(word) && !stopWords.has(word);
}

function terms(tokens: string[]): Set<string> {
  const result = new Set<string>();
  for (let i = 0; i < tokens.length; i++) {
    if (!meaningful(tokens[i])) continue;
    let phrase = tokens[i];
    result.add(phrase);
    for (let j = i + 1; j < Math.min(i + 3, tokens.length) && meaningful(tokens[j]); j++) {
      phrase += ' ' + tokens[j];
      result.add(phrase);
    }
  }
  return result;
}

function hasPhrase(text: string, phrase: string) {
  return (' ' + text + ' ').includes(' ' + phrase + ' ');
}

function containsKeyword(phrases: string[], terms: string[]) {
  return phrases.some((phrase) => terms.some((term) => hasPhrase(phrase, term)));
}

const fold = (word: string) => word.normalize('NFD').replace(/\p{M}/gu, '');
const mathPhrase = (text: string) => words(text).map(fold).join(' ');

interface MathTerm {
  term: string;
  key: string;
  phrases: string[];
  curated: boolean;
}

interface MathIndexNode {
  children: Map<string, MathIndexNode>;
  term?: MathTerm;
}

function regularPlural(phrase: string): string | undefined {
  const last = phrase.split(' ').at(-1)!;
  if (!phrase.includes(' ') || !/^[a-z]{3,}$/.test(last)) return;
  if (/(?:ss|ch|sh|x)$/.test(last)) return phrase + 'es';
  if (last.endsWith('s')) return;
  if (/[^aeiou]y$/.test(last)) return phrase.slice(0, -1) + 'ies';
  return phrase + 's';
}

function buildMathIndex() {
  const byPhrase = new Map<string, MathTerm>();
  for (const term of eomTitles) {
    if (term.length > 100 || /^(?:main page$|list of |index of )|\(disambiguation\)$/i.test(term)) continue;
    const key = mathPhrase(term);
    if (key.split(' ').some(meaningful) && !byPhrase.has(key)) {
      byPhrase.set(key, { term, key, phrases: [], curated: false });
    }
  }
  for (const { term, aliases = [] } of arxivMathTerms) {
    const key = mathPhrase(term);
    const concept = { term, key, phrases: [], curated: true };
    for (const phrase of [key, ...aliases.map(mathPhrase)]) byPhrase.set(phrase, concept);
  }
  for (const concept of new Set(byPhrase.values())) {
    const plural = regularPlural(concept.key);
    if (plural && !byPhrase.has(plural)) byPhrase.set(plural, concept);
  }
  const root: MathIndexNode = { children: new Map() };
  for (const [phrase, concept] of byPhrase) {
    concept.phrases.push(phrase);
    let node = root;
    for (const token of phrase.split(' ')) {
      let child = node.children.get(token);
      if (!child) node.children.set(token, (child = { children: new Map() }));
      node = child;
    }
    node.term = concept;
  }
  return { root, byPhrase };
}

const mathIndex = buildMathIndex();

function matchingMathTerms(words: string[]): Set<MathTerm> {
  const tokens = words.map(fold);
  const hits = new Set<MathTerm>();
  for (let start = 0; start < tokens.length; start++) {
    let node: MathIndexNode | undefined = mathIndex.root;
    for (let end = start; end < tokens.length; end++) {
      node = node.children.get(tokens[end]);
      if (!node) break;
      if (node.term) hits.add(node.term);
    }
  }
  return hits;
}

interface ResearchSignal {
  project: string;
  term: string;
  strength: number;
  paperId: string | null;
}

const genericContextWords = new Set([
  'chapter',
  'definition',
  'draft',
  'example',
  'examples',
  'exercise',
  'exercises',
  'notes',
  'project',
  'proof',
  'research',
  'reading',
  'theorem',
]);

function researchTerms(tokens: string[], allowUnindexed: boolean) {
  const concepts = new Map<string, string>();
  for (const term of matchingMathTerms(tokens)) {
    if (
      !broadKeywords.has(term.key) &&
      !genericContextWords.has(term.key) &&
      (allowUnindexed || term.curated || term.key.includes(' '))
    ) {
      concepts.set(term.key, term.term);
    }
  }
  if (allowUnindexed) {
    for (const phrase of terms(tokens.map(fold))) {
      const pieces = phrase.split(' ');
      if (
        pieces.length > 1 &&
        pieces.some((word) => !broadKeywords.has(word)) &&
        pieces.every((word) => !genericContextWords.has(word))
      ) {
        const indexed = mathIndex.byPhrase.get(phrase);
        const key = indexed?.key ?? phrase;
        if (!concepts.has(key)) concepts.set(key, indexed?.term ?? phrase);
      }
    }
  }
  return concepts;
}

function researchSignals(context: readonly ArxivResearchContext[]) {
  const signals = new Map<string, ResearchSignal[]>();
  for (const source of context) {
    const project = source.project_title.trim().slice(0, 120);
    if (!project) continue;
    const collect = (texts: string[], headings: boolean) => {
      for (const text of texts) {
        for (const [key, term] of researchTerms(words(text.slice(0, 1200)), headings)) {
          const strength = headings ? (key.includes(' ') ? 1 : 0.76) : 0.64;
          const signal = { project, term, strength, paperId: source.paper_id };
          // Keep at most two sources so a candidate cannot recommend itself from its own project link.
          const entries = signals.get(key) ?? [];
          const index = entries.findIndex((item) => item.paperId === signal.paperId);
          if (index >= 0 && strongerResearchSignal(entries[index], signal) <= 0) continue;
          if (index >= 0) entries[index] = signal;
          else entries.push(signal);
          entries.sort(strongerResearchSignal).splice(2);
          signals.set(key, entries);
        }
      }
    };
    collect(source.headings, true);
    collect(source.excerpts, false);
  }
  return signals;
}

function strongerResearchSignal(left: ResearchSignal, right: ResearchSignal) {
  return (
    right.strength - left.strength ||
    compare(left.project, right.project) ||
    compare(left.term, right.term) ||
    compare(left.paperId ?? '', right.paperId ?? '')
  );
}

function researchMatch(
  paperId: string,
  title: string[],
  abstract: string[],
  signals: Map<string, ResearchSignal[]>,
) {
  let best: ResearchSignal | undefined;
  const match = (tokens: string[], placement: number) => {
    for (const key of researchTerms(tokens, true).keys()) {
      const source = signals.get(key)?.find((signal) => signal.paperId !== paperId);
      if (!source) continue;
      const candidate = { ...source, strength: source.strength * placement };
      if (!best || strongerResearchSignal(candidate, best) < 0) best = candidate;
    }
  };
  match(title, 1);
  match(abstract.slice(0, 350), 0.58);
  return best;
}

function decay(timestamp: string, now: number, halfLifeDays: number) {
  const time = Date.parse(timestamp);
  return Number.isFinite(time) ? 2 ** (-Math.max(0, now - time) / (halfLifeDays * day)) : 0;
}

function actionWeight(action: ArxivDeckFeedback) {
  if (action.reaction === 'not_interested') return -2;
  if (action.is_saved) return 3;
  if (action.reaction === 'liked') return 2;
  return action.reaction === 'interested' ? 1 : 0;
}

interface MathTermSignal {
  score: number;
  positivePapers: number;
  positiveTitles: number;
}

function learn(feedback: readonly ArxivDeckFeedback[], now: number) {
  const latest = new Map<string, ArxivDeckFeedback>();
  for (const action of feedback) {
    const previous = latest.get(action.paper_id);
    if (!previous || Date.parse(action.updated_at) >= Date.parse(previous.updated_at)) {
      latest.set(action.paper_id, action);
    }
  }
  const profile = new Map<string, number>();
  const mathematicalInterests = new Map<MathTerm, MathTermSignal>();
  const excluded = new Set<string>();
  for (const action of [...latest.values()].sort((a, b) => compare(a.paper_id, b.paper_id))) {
    if (action.reaction === 'not_interested') excluded.add(action.paper_id);
    const weight = actionWeight(action) * decay(action.updated_at, now, 45);
    if (Math.abs(weight) < 0.01) continue;
    const titleWords = words(action.title);
    const abstractWords = words(action.abstract);
    const titleTerms = terms(titleWords);
    for (const term of titleTerms) profile.set(term, (profile.get(term) ?? 0) + weight);
    for (const term of terms(abstractWords)) {
      if (!titleTerms.has(term)) profile.set(term, (profile.get(term) ?? 0) + weight * 0.22);
    }
    const titleHits = matchingMathTerms(titleWords);
    for (const concept of new Set([...titleHits, ...matchingMathTerms(abstractWords)])) {
      const inTitle = titleHits.has(concept);
      const signal = mathematicalInterests.get(concept) ?? { score: 0, positivePapers: 0, positiveTitles: 0 };
      signal.score += weight * (inTitle ? 1 : 0.22);
      if (weight > 0) {
        signal.positivePapers++;
        if (inTitle) signal.positiveTitles++;
      }
      mathematicalInterests.set(concept, signal);
    }
  }
  return { profile, mathematicalInterests, excluded };
}

function learnedMatch(title: string[], abstract: string[], profile: Map<string, number>) {
  const titleTerms = terms(title);
  const hits: { term: string; score: number }[] = [];
  const match = (term: string, placement: number) => {
    const value = profile.get(term);
    if (value) hits.push({ term, score: value * placement * (term.includes(' ') ? 1.2 : 1) });
  };
  for (const term of titleTerms) match(term, 1);
  for (const term of terms(abstract)) if (!titleTerms.has(term)) match(term, 0.42);
  const positive = hits
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || compare(a.term, b.term));
  const negative = hits
    .filter((hit) => hit.score < 0)
    .sort((a, b) => a.score - b.score || compare(a.term, b.term));
  const strength = (matches: typeof hits) => {
    const total = matches.slice(0, 3).reduce((sum, hit, i) => sum + Math.abs(hit.score) / (i + 1), 0);
    return total / (total + 3);
  };
  return { score: strength(positive) - strength(negative), term: positive[0]?.term };
}

function keywordsByTerm(keywords: readonly ArxivDeckKeyword[]) {
  const entries = new Map<string, ArxivDeckKeyword>();
  for (const keyword of keywords) {
    const phrase = mathPhrase(keyword.term);
    const key = mathIndex.byPhrase.get(phrase)?.key ?? phrase;
    if (!key) continue;
    const previous = entries.get(key);
    const term = keyword.term.trim();
    // Explicit Show less takes precedence if the same normalized term appears in both lists.
    if (
      !previous ||
      (keyword.mode === 'less' && previous.mode !== 'less') ||
      (keyword.mode === previous.mode && compare(term, previous.term) < 0)
    ) {
      entries.set(key, { term, mode: keyword.mode });
    }
  }
  return entries;
}

function keywordSuggestions(
  interests: Map<MathTerm, MathTermSignal>,
  keywords: Map<string, ArxivDeckKeyword>,
) {
  const manualTerms = [...keywords].map(([key, rule]) => ({
    mode: rule.mode,
    phrases: mathIndex.byPhrase.get(key)?.phrases ?? [key],
  }));
  const specificity = (term: MathTerm) => (term.key.includes(' ') ? 1.3 : 0.55);
  const ranked = [...interests]
    .filter(([term, signal]) => {
      if (signal.positivePapers < 2 || signal.score <= 0.25) return false;
      if (term.curated) return true;
      if (broadKeywords.has(term.key)) return signal.positiveTitles >= 4;
      if (!term.key.includes(' ')) return signal.positiveTitles >= 2;
      return signal.positiveTitles >= 1 || signal.positivePapers >= 3;
    })
    .sort(
      ([a, left], [b, right]) =>
        right.score * specificity(b) - left.score * specificity(a) || compare(a.key, b.key),
    );
  const suggestions: MathTerm[] = [];
  for (const [term] of ranked) {
    if (
      suggestions.some(
        (other) =>
          containsKeyword(term.phrases, other.phrases) || containsKeyword(other.phrases, term.phrases),
      )
    )
      continue;
    if (
      manualTerms.some(
        ({ mode, phrases }) =>
          containsKeyword(phrases, term.phrases) ||
          (mode === 'less' && containsKeyword(term.phrases, phrases)),
      )
    )
      continue;
    suggestions.push(term);
    if (suggestions.length === 6) break;
  }
  return suggestions.map(({ term }) => term);
}

interface Ranked {
  id: string;
  title: string;
  signature: Set<string>;
  category?: string;
  follows: { key: string; term: string; quality: number }[];
  subscription: number;
  freshness: number;
  score: number;
  discouraged: boolean;
  reason: string;
}

function nearDuplicate(left: Ranked, right: Ranked) {
  if (left.title && left.title === right.title) return true;
  const smaller = Math.min(left.signature.size, right.signature.size);
  if (smaller < 4) return false;
  let shared = 0;
  for (const word of left.signature) if (right.signature.has(word)) shared++;
  return shared / (left.signature.size + right.signature.size - shared) >= 0.8;
}

function seededOrder(seed: string | number, id: string) {
  let hash = 2166136261;
  for (const character of String(seed) + '\0' + id) {
    hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
  }
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d);
  return (hash ^ (hash >>> 15)) >>> 0;
}

export function buildArxivDeck({ candidates, feedback, keywords, research = [], now, seed }: DeckInput): {
  items: { paper_id: string; reason: string }[];
  suggestions: string[];
} {
  const asOf = new Date(now).getTime();
  if (!Number.isFinite(asOf)) throw new RangeError('Invalid arXiv deck date');
  const { profile, mathematicalInterests, excluded } = learn(feedback, asOf);
  const rules = keywordsByTerm(keywords);
  const contextualSignals = researchSignals(research);
  const available = candidates.filter((paper) => paper.paper_id && !excluded.has(paper.paper_id));
  const subscriptionScore = (paper: ArxivDeckCandidate) =>
    Number.isFinite(paper.subscription_score) ? Math.max(0, paper.subscription_score) : 0;
  const subscriptionMax = available.reduce((max, paper) => Math.max(max, subscriptionScore(paper)), 0);
  const hasFollow = [...rules.values()].some((rule) => rule.mode === 'follow');
  const hasFreshness = available.some((paper) => Number.isFinite(Date.parse(paper.updated_at)));
  const totalWeight =
    (profile.size ? 35 : 0) +
    (hasFollow ? 20 : 0) +
    (contextualSignals.size ? 24 : 0) +
    (subscriptionMax ? 25 : 0) +
    (hasFreshness ? 20 : 0);

  const ranked: Ranked[] = available.map((paper) => {
    const titleWords = words(paper.title);
    const abstractWords = words(paper.abstract);
    const title = titleWords.join(' ');
    const abstract = abstractWords.join(' ');
    const mathTitle = fold(title);
    const mathAbstract = fold(abstract);
    const follows: Ranked['follows'] = [];
    let less = 0;
    for (const [key, rule] of rules) {
      const phrases = mathIndex.byPhrase.get(key)?.phrases ?? [key];
      const inTitle = phrases.some((phrase) => hasPhrase(mathTitle, phrase));
      const inAbstract = phrases.some((phrase) => hasPhrase(mathAbstract, phrase));
      if (!inTitle && !inAbstract) continue;
      const quality = inTitle ? (key.includes(' ') ? 1 : 0.85) : 0.55;
      if (rule.mode === 'follow') follows.push({ key, term: rule.term, quality });
      else less = Math.min(1.3, less + quality);
    }
    follows.sort((a, b) => b.quality - a.quality || compare(a.key, b.key));
    const learned = profile.size
      ? learnedMatch(titleWords, abstractWords, profile)
      : { score: 0, term: undefined };
    const contextual = contextualSignals.size
      ? researchMatch(paper.paper_id, titleWords, abstractWords, contextualSignals)
      : undefined;
    const subscription = subscriptionMax
      ? Math.log1p(subscriptionScore(paper)) / Math.log1p(subscriptionMax)
      : 0;
    const freshness = decay(paper.updated_at, asOf, 7);
    const followed = follows[0];
    const followScore = followed ? Math.min(1, followed.quality + 0.08 * (follows.length - 1)) : 0;
    const category = paper.categories.find((value) => value.trim())?.trim();
    const personalContributions = [
      {
        score: learned.score * 35,
        reason: learned.term ? 'Your feedback points to “' + learned.term + '”.' : '',
      },
      {
        score: followScore * 20,
        reason: followed ? 'Matches your followed keyword “' + followed.term + '”.' : '',
      },
      {
        score: (contextual?.strength ?? 0) * 24,
        reason: contextual ? `Matches research project “${contextual.project}” on “${contextual.term}”.` : '',
      },
    ];
    const contributions = [
      ...personalContributions,
      {
        score: subscription * 25,
        reason: category
          ? 'Matches your arXiv subscriptions and is listed in ' + category + '.'
          : 'Matches your arXiv subscriptions.',
      },
      { score: freshness * 20, reason: freshness >= 0.5 ? 'Updated on arXiv in the last week.' : '' },
    ];
    const strongestReason = (signals: typeof contributions) =>
      signals.sort((a, b) => b.score - a.score).find((signal) => signal.score > 0 && signal.reason)?.reason;
    const reason =
      (contextual && less === 0 ? strongestReason(personalContributions) : undefined) ??
      strongestReason(contributions) ??
      (category ? 'From the arXiv category ' + category + '.' : 'From the available arXiv feed.');
    const score =
      contributions.reduce((sum, signal) => sum + signal.score, 0) / (totalWeight || 1) - 0.62 * less;
    return {
      id: paper.paper_id,
      title,
      signature: new Set(titleWords.filter(meaningful)),
      category,
      follows,
      subscription,
      freshness,
      score,
      discouraged: less > 0 || learned.score < -0.25,
      reason,
    };
  });
  ranked.sort((a, b) => b.score - a.score || compare(a.id, b.id) || compare(a.title, b.title));

  const selected: Ranked[] = [];
  const items: { paper_id: string; reason: string }[] = [];
  const remaining = () =>
    ranked.filter(
      (candidate) => !selected.some((paper) => paper.id === candidate.id || nearDuplicate(paper, candidate)),
    );
  const append = (paper: Ranked | undefined, reason = paper?.reason) => {
    if (!paper || !reason) return;
    selected.push(paper);
    items.push({ paper_id: paper.id, reason });
  };
  const bestAvailable = () => {
    let best: Ranked | undefined;
    let bestScore = -Infinity;
    for (const paper of remaining()) {
      const repeated = paper.category
        ? selected.filter((other) => other.category === paper.category).length
        : 0;
      const score = paper.score - 0.025 * repeated;
      if (score > bestScore) {
        best = paper;
        bestScore = score;
      }
    }
    return best;
  };

  for (let i = 0; i < 4; i++) append(bestAvailable());
  const represented = new Set(selected.map((paper) => paper.follows[0]?.key));
  const categories = new Set(selected.map((paper) => paper.category).filter(Boolean));
  const alternate = remaining().filter((paper) => !paper.discouraged);
  const differentFollow = alternate.find(
    (paper) => paper.follows[0] && !represented.has(paper.follows[0].key),
  );
  const differentTerm = differentFollow?.follows[0].term;
  const differentCategory = alternate.find(
    (paper) => paper.subscription > 0 && paper.category && !categories.has(paper.category),
  );
  if (differentFollow && differentTerm)
    append(differentFollow, 'Another followed topic you might enjoy is “' + differentTerm + '”.');
  else if (differentCategory)
    append(
      differentCategory,
      'A subscription match listed in a different arXiv category (' + differentCategory.category + ').',
    );
  else append(bestAvailable());

  const subscribed = remaining().filter((paper) => paper.subscription > 0 && !paper.discouraged);
  const shownCategories = new Set(selected.map((paper) => paper.category));
  const novel = subscribed.filter((paper) => paper.category && !shownCategories.has(paper.category));
  const pool = (novel.length ? novel : subscribed)
    .sort(
      (a, b) =>
        b.subscription * 0.6 + b.freshness * 0.4 - (a.subscription * 0.6 + a.freshness * 0.4) ||
        compare(a.id, b.id),
    )
    .slice(0, 8)
    .sort((a, b) => seededOrder(seed, a.id) - seededOrder(seed, b.id) || compare(a.id, b.id));
  if (pool[0]) append(pool[0], 'A wildcard from your arXiv subscriptions.');
  else append(bestAvailable());

  return { items, suggestions: keywordSuggestions(mathematicalInterests, rules) };
}

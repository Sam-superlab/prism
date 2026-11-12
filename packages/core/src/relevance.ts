/** Transparent ranking shared by ingestion and delivery; contains no network or XML dependencies. */
export interface MatchingPaper {
  title: string;
  abstract: string;
  authors: string[];
  categories: string[];
}
export interface SubscriptionMatchRule {
  subscription_type: 'category' | 'keyword' | 'author' | 'topic';
  subscription_value: string;
  enabled: boolean;
  weight?: number;
}

export function normalizeArxivCategory(value: string): string | null {
  const category = value.trim().replace(/\s*,\s*/g, '.');
  if (!/^[a-z]+(?:-[a-z]+)*(?:\.[a-z]+(?:-[a-z]+)*)?$/i.test(category)) return null;
  const math = /^math\.([a-z]{2})$/i.exec(category);
  return math ? `math.${math[1].toUpperCase()}` : category;
}

const normalize = (value: string) =>
  value.normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/g, ' ').trim();

const matchPoints = { category: 4, author: 6, keyword: 2, topic: 2 };

export function subscriptionMatch(rule: SubscriptionMatchRule) {
  const weight = Math.min(10, Math.max(1, rule.weight ?? 1));
  return {
    reason: `${rule.subscription_type}: ${rule.subscription_value}`,
    score: weight * matchPoints[rule.subscription_type],
  };
}

export function rankSubscriptionMatches(
  paper: MatchingPaper,
  subscriptions: SubscriptionMatchRule[],
): { relevance_score: number; match_reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const body = normalize(`${paper.title} ${paper.abstract}`);
  for (const subscription of subscriptions.filter((sub) => sub.enabled)) {
    const value =
      subscription.subscription_type === 'category'
        ? normalizeArxivCategory(subscription.subscription_value)
        : subscription.subscription_value;
    if (!value) continue;
    const term = normalize(value);
    const matched =
      subscription.subscription_type === 'category'
        ? paper.categories.some((category) => normalize(category) === term)
        : subscription.subscription_type === 'author'
          ? paper.authors.some((author) => normalize(author) === term)
          : term && body.includes(term);
    if (matched) {
      const match = subscriptionMatch({ ...subscription, subscription_value: value });
      score += match.score;
      reasons.push(match.reason);
    }
  }
  return { relevance_score: score, match_reasons: reasons };
}

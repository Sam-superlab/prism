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
const normalize = (value: string) =>
  value.normalize('NFKC').toLocaleLowerCase('en').replace(/\s+/g, ' ').trim();
export function rankSubscriptionMatches(
  paper: MatchingPaper,
  subscriptions: SubscriptionMatchRule[],
): { relevance_score: number; match_reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const body = normalize(`${paper.title} ${paper.abstract}`);
  for (const subscription of subscriptions.filter((sub) => sub.enabled)) {
    const term = normalize(subscription.subscription_value),
      weight = Math.min(10, Math.max(1, subscription.weight ?? 1));
    let points = 0;
    if (
      subscription.subscription_type === 'category' &&
      paper.categories.some((category) => normalize(category) === term)
    )
      points = 4;
    else if (
      subscription.subscription_type === 'author' &&
      paper.authors.some((author) => normalize(author) === term)
    )
      points = 6;
    else if (['keyword', 'topic'].includes(subscription.subscription_type) && term && body.includes(term))
      points = 2;
    if (points) {
      score += points * weight;
      reasons.push(`${subscription.subscription_type}: ${subscription.subscription_value}`);
    }
  }
  return { relevance_score: score, match_reasons: reasons };
}

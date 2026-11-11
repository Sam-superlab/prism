import { DefaultScheduler, Rating, type DefaultSchedulerCard, type DefaultSchedulerCardInput } from 'ts-fsrs';

export type ReviewRating = 'again' | 'hard' | 'good' | 'easy';
export type SerializedCard = Omit<DefaultSchedulerCard<'FSRS-7'>, 'dueAt' | 'lastReviewAt'> & {
  dueAt: string;
  lastReviewAt: string | null;
};
export interface SchedulerConfig {
  desired_retention?: number;
  library_version?: string;
  model_version?: string;
  adapter_version?: string;
  parameters?: { weights?: readonly number[]; maximumInterval?: number; [key: string]: unknown };
}

const grades = { again: Rating.Again, hard: Rating.Hard, good: Rating.Good, easy: Rating.Easy };
const schedulers = new Map<string, ReturnType<typeof DefaultScheduler<'FSRS-7'>>>();

function getScheduler(config: SchedulerConfig = {}) {
  if (config.model_version && config.model_version !== 'FSRS-7')
    throw new Error('Unsupported FSRS model; explicit migration is required');
  if (config.library_version && config.library_version !== '6.0.0')
    throw new Error('Unsupported FSRS library snapshot');
  const retention = config.desired_retention ?? 0.9;
  if (retention < 0.7 || retention > 0.99) throw new Error('Desired retention must be between 0.70 and 0.99');
  const options = {
    version: 'FSRS-7' as const,
    desiredRetention: retention,
    weights: config.parameters?.weights,
    maximumInterval: config.parameters?.maximumInterval ?? 36500,
    enableFuzz: false,
    enableShortTerm: true,
  };
  const key = JSON.stringify(options);
  if (!schedulers.has(key)) schedulers.set(key, DefaultScheduler(options));
  return schedulers.get(key)!;
}

function serialize(card: DefaultSchedulerCard<'FSRS-7'>): SerializedCard {
  return JSON.parse(JSON.stringify(card)) as SerializedCard;
}

function hydrate(card: SerializedCard | Record<string, unknown>): DefaultSchedulerCardInput<'FSRS-7'> {
  if (!card.dueAt || typeof card.dueAt !== 'string')
    throw new Error('Missing FSRS state; initialize the card before review');
  return {
    ...card,
    dueAt: new Date(card.dueAt),
    lastReviewAt: card.lastReviewAt ? new Date(String(card.lastReviewAt)) : null,
  } as DefaultSchedulerCardInput<'FSRS-7'>;
}

export async function createCard(now: string | Date, config: SchedulerConfig = {}): Promise<SerializedCard> {
  const scheduler = await getScheduler(config);
  return serialize(scheduler.newCard({ now: new Date(now) }));
}

export async function reviewCard(input: {
  cardId?: string;
  state: SerializedCard | Record<string, unknown>;
  rating: ReviewRating;
  reviewedAt: string | Date;
  config?: SchedulerConfig;
}): Promise<{
  state: SerializedCard;
  dueAt: string;
  reviewCount: number;
  lapseCount: number;
  log: Record<string, unknown>;
}> {
  const scheduler = await getScheduler(input.config);
  if (!Object.hasOwn(grades, input.rating)) throw new Error('Unknown review rating');
  const result = scheduler.review({
    card: hydrate(input.state),
    grade: grades[input.rating],
    now: new Date(input.reviewedAt),
  });
  const state = serialize(result.card);
  return {
    state,
    dueAt: state.dueAt,
    reviewCount: result.card.reps,
    lapseCount: result.card.lapses,
    log: JSON.parse(JSON.stringify(result.revlog)) as Record<string, unknown>,
  };
}

export async function getRetrievability(
  state: SerializedCard | Record<string, unknown>,
  asOf: string | Date,
  config: SchedulerConfig = {},
): Promise<number | null> {
  if (!state.lastReviewAt) return null;
  const scheduler = await getScheduler(config);
  const card = hydrate(state);
  const elapsed = Math.max(
    0,
    scheduler.chrono.difference(new Date(String(state.lastReviewAt)), new Date(asOf)),
  );
  return Math.max(0, Math.min(1, scheduler.model.forgettingCurve(card, elapsed)));
}

export async function schedulerConfig(config: SchedulerConfig = {}) {
  const scheduler = await getScheduler(config);
  return {
    library_version: '6.0.0',
    model_version: 'FSRS-7',
    adapter_version: '1.0.0',
    desired_retention: config.desired_retention ?? 0.9,
    fuzz_enabled: false,
    parameters: {
      weights: [...scheduler.model.config.weights],
      maximumInterval: config.parameters?.maximumInterval ?? 36500,
    },
  };
}

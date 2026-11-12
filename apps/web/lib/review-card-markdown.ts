export const reviewCardTypes = [
  'statement',
  'hypotheses',
  'proof',
  'example',
  'counterexample',
  'application',
  'custom',
] as const;

type CardType = (typeof reviewCardTypes)[number];
type Section = 'prompt' | 'answer';
type Card = { card_type: CardType; prompt: string; answer: string };
type Draft = { line: number; card_type: CardType; prompt?: string[]; answer?: string[] };

export const reviewCardTemplate = String.raw`## Card: statement
### Prompt
What is a prime ideal?

### Answer
A proper ideal $P$ is prime if $ab \in P$ implies $a \in P$ or $b \in P$.

## Card: example
### Prompt
Give an example of a prime ideal in $\mathbb{Z}$.

### Answer
The ideal $(2)$ is prime because $\mathbb{Z}/(2)$ is an integral domain.`;

export function parseReviewCards(source: string): Card[] {
  const normalized = source.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  const lines = normalized.split('\n');
  const wrapper = /^(`{3,}|~{3,})(?:markdown|md)?[ \t]*$/i.exec(lines[0]);
  const wrapped = wrapper && lines.at(-1)?.trim() === wrapper[1];
  const cards: Card[] = [];
  let current: Draft | undefined;
  let section: Section | undefined;
  let fence = '';

  const trimBlankLines = (lines: string[] = []) => {
    const first = lines.findIndex((line) => line.trim());
    return first < 0 ? '' : lines.slice(first, lines.findLastIndex((line) => line.trim()) + 1).join('\n');
  };
  function finish() {
    if (!current) return;
    const prompt = trimBlankLines(current.prompt);
    const answer = trimBlankLines(current.answer);
    if (!prompt || !answer) throw new Error(`Line ${current.line} needs both a prompt and an answer.`);
    if (prompt.length > 200000 || answer.length > 200000) {
      throw new Error(`Line ${current.line} contains a prompt or answer longer than 200,000 characters.`);
    }
    cards.push({ card_type: current.card_type, prompt, answer });
    if (cards.length > 50) throw new Error('Import up to 50 cards at a time.');
  }

  for (let index = wrapped ? 1 : 0; index < lines.length - (wrapped ? 1 : 0); index++) {
    const line = lines[index];
    const number = index + 1;
    const fenceMarker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      current?.[section!]?.push(line);
      if (
        fenceMarker?.[1][0] === fence[0] &&
        fenceMarker[1].length >= fence.length &&
        !fenceMarker[2].trim()
      ) {
        fence = '';
      }
      continue;
    }
    const cardHeading = /^ {0,3}## Card(?:\s*:\s*(.*))?\s*$/i.exec(line);
    if (cardHeading) {
      finish();
      const type = (cardHeading[1]?.trim().toLowerCase() ?? 'statement') as CardType;
      if (!reviewCardTypes.includes(type)) throw new Error(`Line ${number} has an unknown review focus.`);
      current = { line: number, card_type: type };
      section = undefined;
      continue;
    }
    const sectionHeading = /^ {0,3}### (Prompt|Answer)\s*$/i.exec(line);
    if (sectionHeading) {
      const next = sectionHeading[1].toLowerCase() as Section;
      if (!current || (next === 'prompt' ? section !== undefined : section !== 'prompt')) {
        throw new Error(`Line ${number} must follow the card, prompt, and answer order.`);
      }
      section = next;
      current[section] = [];
    } else if (current && section) {
      if (fenceMarker) fence = fenceMarker[1];
      current[section]!.push(line);
    } else if (line.trim()) {
      throw new Error(`Line ${number} should start with ${current ? '### Prompt' : '## Card'}.`);
    }
  }
  if (fence) throw new Error('Close the fenced code block before importing.');
  finish();
  return cards;
}

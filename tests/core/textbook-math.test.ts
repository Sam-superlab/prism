import { describe, expect, it } from 'vitest';
import { convertTextbookMath } from '../../apps/web/lib/textbook-math';

describe('textbook math conversion', () => {
  it('groups Unicode notation into editable LaTeX without changing the surrounding prose', () => {
    expect(convertTextbookMath('Let A ⊆ Λ. Prove the claim.')).toBe(
      String.raw`Let $A \subseteq \Lambda$. Prove the claim.`,
    );
    expect(convertTextbookMath('Λ')).toBe(String.raw`$\Lambda$`);
  });

  it('keeps consecutive script characters together and separates quantifiers from variables', () => {
    expect(convertTextbookMath('For ∀x ∈ ℝ, compare x₁₀²³.')).toBe(
      String.raw`For $\forall x \in \mathbb{R}$, compare $x_{10}^{23}$.`,
    );
  });

  it('recognizes explicit double-struck and script letters, including a script style selector', () => {
    expect(convertTextbookMath('Let 𝔽 ⊆ ℂ and 𝒜 ∈ ℱ.')).toBe(
      String.raw`Let $\mathbb{F} \subseteq \mathbb{C}$ and $\mathscr{A} \in \mathscr{F}$.`,
    );
    expect(convertTextbookMath('ℱ\uFE00')).toBe(String.raw`$\mathcal{F}$`);
    expect(convertTextbookMath('ℱ\uFE01')).toBe(String.raw`$\mathscr{F}$`);
  });

  it('preserves existing LaTeX and Markdown code', () => {
    const existing = [
      'A literal `Λ ⊆ A`, existing $A ⊆ Λ$, and spaced $ A ⊆ Λ $.',
      '',
      '$$',
      'Λ ⊆ A',
      '$$',
      '',
      '```text',
      'A ⊆ Λ',
      '```',
    ].join('\n');
    const converted = convertTextbookMath(`${existing}\n\nLet A ⊆ Λ.`);
    expect(converted).toBe(`${existing}\n\n${String.raw`Let $A \subseteq \Lambda$.`}`);
    expect(convertTextbookMath(converted)).toBe(converted);
  });
});

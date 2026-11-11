function unicodeMathCapitals(start: number, command: 'mathbb' | 'mathscr'): Record<string, string> {
  const alphabet: Record<string, string> = {};
  for (let offset = 0; offset < 26; offset++) {
    const glyph = String.fromCodePoint(start + offset);
    // Some capitals are encoded in Letterlike Symbols instead of this block.
    const letter = glyph.normalize('NFKD');
    if (/^[A-Z]$/.test(letter)) alphabet[glyph] = '\\' + command + '{' + letter + '}';
  }
  return alphabet;
}

const scriptCapitals = {
  ...unicodeMathCapitals(0x1d49c, 'mathscr'),
  ℬ: '\\mathscr{B}',
  ℰ: '\\mathscr{E}',
  ℱ: '\\mathscr{F}',
  ℋ: '\\mathscr{H}',
  ℐ: '\\mathscr{I}',
  ℒ: '\\mathscr{L}',
  ℳ: '\\mathscr{M}',
  ℛ: '\\mathscr{R}',
};

const letters: Record<string, string> = {
  ...scriptCapitals,
  ...unicodeMathCapitals(0x1d538, 'mathbb'),
  α: '\\alpha',
  β: '\\beta',
  γ: '\\gamma',
  δ: '\\delta',
  ε: '\\varepsilon',
  ζ: '\\zeta',
  η: '\\eta',
  θ: '\\theta',
  ι: '\\iota',
  κ: '\\kappa',
  λ: '\\lambda',
  μ: '\\mu',
  ν: '\\nu',
  ξ: '\\xi',
  ο: '\\omicron',
  π: '\\pi',
  ρ: '\\rho',
  σ: '\\sigma',
  τ: '\\tau',
  υ: '\\upsilon',
  φ: '\\varphi',
  χ: '\\chi',
  ψ: '\\psi',
  ω: '\\omega',
  ϵ: '\\epsilon',
  ϑ: '\\vartheta',
  ϕ: '\\phi',
  ϖ: '\\varpi',
  ϱ: '\\varrho',
  ς: '\\varsigma',
  Γ: '\\Gamma',
  Δ: '\\Delta',
  Θ: '\\Theta',
  Λ: '\\Lambda',
  Ξ: '\\Xi',
  Π: '\\Pi',
  Σ: '\\Sigma',
  Υ: '\\Upsilon',
  Φ: '\\Phi',
  Ψ: '\\Psi',
  Ω: '\\Omega',
  ℕ: '\\mathbb{N}',
  ℤ: '\\mathbb{Z}',
  ℚ: '\\mathbb{Q}',
  ℝ: '\\mathbb{R}',
  ℂ: '\\mathbb{C}',
  ℍ: '\\mathbb{H}',
  ℙ: '\\mathbb{P}',
  𝕜: '\\mathbb{k}',
};

const operators: Record<string, string> = {
  '⊆': '\\subseteq',
  '⊂': '\\subset',
  '⊈': '\\nsubseteq',
  '⊊': '\\subsetneq',
  '⊇': '\\supseteq',
  '⊃': '\\supset',
  '⊉': '\\nsupseteq',
  '⊋': '\\supsetneq',
  '∈': '\\in',
  '∉': '\\notin',
  '∋': '\\ni',
  '∪': '\\cup',
  '∩': '\\cap',
  '∖': '\\setminus',
  '≤': '\\leq',
  '≥': '\\geq',
  '≠': '\\neq',
  '≡': '\\equiv',
  '≈': '\\approx',
  '≅': '\\cong',
  '∼': '\\sim',
  '≔': '\\coloneqq',
  '⊥': '\\perp',
  '∥': '\\parallel',
  '×': '\\times',
  '÷': '\\div',
  '·': '\\cdot',
  '⋅': '\\cdot',
  '∘': '\\circ',
  '−': '-',
  '±': '\\pm',
  '∓': '\\mp',
  '⊕': '\\oplus',
  '⊗': '\\otimes',
  '→': '\\to',
  '⟶': '\\longrightarrow',
  '↗': '\\nearrow',
  '↘': '\\searrow',
  '←': '\\leftarrow',
  '↔': '\\leftrightarrow',
  '↦': '\\mapsto',
  '⇒': '\\Rightarrow',
  '⇐': '\\Leftarrow',
  '⇔': '\\Leftrightarrow',
  '∧': '\\wedge',
  '∨': '\\vee',
};

const prefixes: Record<string, string> = {
  '∀': '\\forall',
  '∃': '\\exists',
  '∄': '\\nexists',
  '¬': '\\neg',
};
const constants: Record<string, string> = {
  '∅': '\\varnothing',
  '∞': '\\infty',
};
const primes: Record<string, string> = { '′': "'", '″': "''", '‴': "'''" };
const superscripts: Record<string, string> = {
  '⁰': '0',
  '¹': '1',
  '²': '2',
  '³': '3',
  '⁴': '4',
  '⁵': '5',
  '⁶': '6',
  '⁷': '7',
  '⁸': '8',
  '⁹': '9',
  '⁺': '+',
  '⁻': '-',
  '⁼': '=',
  '⁽': '(',
  '⁾': ')',
  ⁿ: 'n',
  ⁱ: 'i',
};
const subscripts: Record<string, string> = {
  '₀': '0',
  '₁': '1',
  '₂': '2',
  '₃': '3',
  '₄': '4',
  '₅': '5',
  '₆': '6',
  '₇': '7',
  '₈': '8',
  '₉': '9',
  '₊': '+',
  '₋': '-',
  '₌': '=',
  '₍': '(',
  '₎': ')',
  ₐ: 'a',
  ₑ: 'e',
  ₕ: 'h',
  ᵢ: 'i',
  ⱼ: 'j',
  ₖ: 'k',
  ₗ: 'l',
  ₘ: 'm',
  ₙ: 'n',
  ₒ: 'o',
  ₚ: 'p',
  ᵣ: 'r',
  ₛ: 's',
  ₜ: 't',
  ᵤ: 'u',
  ᵥ: 'v',
  ₓ: 'x',
};

const commands = { ...letters, ...operators, ...prefixes, ...constants, ...primes };
const keys = (symbols: Record<string, string>) => Object.keys(symbols).join('');
// Unicode VS1 selects chancery and VS2 selects roundhand on script capitals.
const scriptVariant = '[' + keys(scriptCapitals) + '][\uFE00\uFE01]';
const knownSymbol = new RegExp('[' + keys({ ...commands, ...superscripts, ...subscripts }) + ']', 'u');
const notation = new RegExp(
  scriptVariant + '|[' + keys(superscripts) + ']+|[' + keys(subscripts) + ']+|[' + keys(commands) + '{}]',
  'gu',
);

// Match flat expressions around a known symbol. Multi-letter words are never operands.
const gap = /[ \t\u00a0\u2009\u202f]*/.source;
const letter = `(?:${scriptVariant}|[A-Za-z${keys(letters)}])`;
const script = `[${keys({ ...superscripts, ...subscripts, ...primes })}]`;
const number = /[0-9]+(?:\.[0-9]+)?/.source;
const atom = `(?:${letter}|${number}|[${keys(constants)}])${script}*`;
const list = `${atom}(?:${gap},${gap}${atom})*`;
const term = String.raw`(?:${letter}\(${gap}${list}${gap}\)${script}*|\{${gap}${list}${gap}\}|${atom})`;
const prefix = `[${keys(prefixes).replace('∃', '')}−]|∃!?`;
const operand = String.raw`(?:(?:${prefix})${gap}|[+-](?=\S))?${term}`;
const operation = `[+=<>:/*${keys(operators)}-]`;
const endOfTerm = /(?![\p{L}\p{N}_])/u.source;
const expression = new RegExp(
  [
    String.raw`(?<![\p{L}\p{N}_\\])${operand}(?:${gap}${operation}${gap}${operand})*${endOfTerm}`,
    `[${keys(operators)}]${gap}${operand}${endOfTerm}`,
    `[${keys({ ...operators, ...prefixes, ...constants })}]`,
  ].join('|'),
  'gu',
);

// Keep source-provided LaTeX, code, URLs, and extraction notices verbatim.
const protectedMarkup = new RegExp(
  [
    /^ {0,3}(?<fence>\x60{3,}|~{3,})[^\n]*(?:\n[\s\S]*?(?:^ {0,3}\k<fence>[\x60~]*[ \t]*(?=\r?$)|(?![\s\S])))/
      .source,
    /(?<!\x60)(?<ticks>\x60+)(?!\x60)[\s\S]*?(?<!\x60)\k<ticks>(?!\x60)/.source,
    /(?<!\\)\$\$(?:\\.|[^\\$]|\$(?!\$))*\$\$/.source,
    /(?<![\\$])\$(?!\$)(?:\\.|[^\\$\n])+\$/.source,
    /\\\([^\n]*?\\\)|\\\[[\s\S]*?\\\]/.source,
    /https?:\/\/[^\s<>]+/.source,
    /\[(?:Formula omitted|Image[ :]|Superscript:|Subscript:)[^\]\n]*\]/.source,
  ].join('|'),
  'gm',
);

function convertProse(text: string): string {
  return text.replace(expression, (formula) => {
    if (!knownSymbol.test(formula)) return formula;
    const latex = formula.replace(notation, (symbol, index: number) => {
      const glyph = symbol.replace(/[\uFE00\uFE01]$/u, '');
      if (glyph in commands) {
        const command = symbol.endsWith('\uFE00')
          ? commands[glyph].replace('\\mathscr', '\\mathcal')
          : commands[glyph];
        // Terminate a control word before an adjacent ASCII variable, as in ∀x.
        const needsSpace =
          /\\[A-Za-z]+$/.test(command) && /^[A-Za-z]$/.test(formula[index + symbol.length] ?? '');
        return needsSpace ? command + ' ' : command;
      }
      if (symbol === '{' || symbol === '}') return '\\' + symbol;
      if (symbol[0] in superscripts)
        return '^{' + Array.from(symbol, (part) => superscripts[part]).join('') + '}';
      return '_{' + Array.from(symbol, (part) => subscripts[part]).join('') + '}';
    });
    return '$' + latex + '$';
  });
}

export function convertTextbookMath(text: string): string {
  if (!knownSymbol.test(text)) return text;
  let result = '';
  let offset = 0;
  for (const match of text.matchAll(protectedMarkup)) {
    result += convertProse(text.slice(offset, match.index)) + match[0];
    offset = match.index + match[0].length;
  }
  return result + convertProse(text.slice(offset));
}

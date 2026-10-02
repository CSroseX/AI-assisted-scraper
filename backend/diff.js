// Deterministic paragraph-level diff with noise filtering.
// No LLM involved: this is the "detect deterministically" half of the plan's
// governing principle. The explainer (LLM) only runs on what this emits.

// Collapses whitespace so line-wrapping differences don't count as a change.
function normalizeParagraph(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function splitParagraphs(text) {
  return String(text || '')
    .split(/\n\s*\n+/)
    .map(normalizeParagraph)
    .filter(Boolean);
}

// Patterns that look like noise: timestamps, counters, ad rotation ids.
const NOISE_PATTERNS = [
  /^\d{1,2}[:/]\d{2}([:/]\d{2,4})?/, // times/dates like 12:34 or 1/2/2024
  /\b(am|pm)\b/i,
  /^(©|copyright).*\d{4}/i, // "© 2024 Example" footers (year changes yearly)
  /\blast (updated|modified)\b.*\d/i, // "Last updated: 1/1/2024" style footers
  /\b\d+\s+(people|views?|visitors?|online|users?)\b/i, // live counters
  /^(loading|please wait)\.{0,3}$/i
];

function isNoise(paragraph) {
  return NOISE_PATTERNS.some((pattern) => pattern.test(paragraph));
}

// Longest Common Subsequence over paragraphs, then walked back into a diff.
function diffParagraphs(beforeParagraphs, afterParagraphs) {
  const n = beforeParagraphs.length;
  const m = afterParagraphs.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = beforeParagraphs[i] === afterParagraphs[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (beforeParagraphs[i] === afterParagraphs[j]) {
      ops.push({ type: 'unchanged', text: beforeParagraphs[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ type: 'removed', text: beforeParagraphs[i] });
      i++;
    } else {
      ops.push({ type: 'added', text: afterParagraphs[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: 'removed', text: beforeParagraphs[i] });
    i++;
  }
  while (j < m) {
    ops.push({ type: 'added', text: afterParagraphs[j] });
    j++;
  }

  return ops;
}

// Computes a noise-filtered paragraph diff between two snapshots' text content.
// Returns { changes, hasMeaningfulChange } where `changes` only contains
// added/removed paragraphs that are not noise (unchanged paragraphs are dropped).
function computeDiff(beforeText, afterText) {
  const before = splitParagraphs(beforeText);
  const after = splitParagraphs(afterText);
  const ops = diffParagraphs(before, after);

  const changes = ops
    .filter((op) => op.type !== 'unchanged')
    .filter((op) => !isNoise(op.text));

  return {
    changes,
    hasMeaningfulChange: changes.length > 0
  };
}

module.exports = { computeDiff, splitParagraphs, isNoise, diffParagraphs };

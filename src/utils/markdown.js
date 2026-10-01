export function normalizeAssistantMarkdown(content) {
  const text = String(content || '');

  // Handle model outputs where markdown table rows are flattened into one line,
  // e.g. "| h1 | h2 | |---|---| | r1c1 | r1c2 |".
  const looksLikeFlattenedTable = /\|\s*[-:]{3,}[-:|\s]*\|/.test(text) && !/\n\|/.test(text);
  if (!looksLikeFlattenedTable) return text;

  return text
    .replace(/\|\s+\|/g, '|\n|')
    .replace(/\n\s+/g, '\n')
    .trim();
}

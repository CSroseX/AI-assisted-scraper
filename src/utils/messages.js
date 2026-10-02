export const LOADER_TEXT = {
  writer: 'AI Writer is spinning the content...'
};

// Index of the last message with the given `type`, or -1.
export function findLastIndexByType(messages, type) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === type) return i;
  }
  return -1;
}

// Replaces the trailing message when it is still the given loader text.
export function replaceTrailingLoader(messages, loaderText, replacement) {
  if (!messages.length || messages[messages.length - 1].content !== loaderText) return messages;
  return [...messages.slice(0, -1), replacement];
}

// Maps a stored screenshot path (possibly Windows-style) to a URL path segment.
export function normalizeScreenshotPath(path) {
  return String(path || '').replace(/\\/g, '/').replace(/^[./]+/, '');
}

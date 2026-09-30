export const LOADER_TEXT = {
  writer: 'AI Writer is spinning the content...',
  reviewer: 'AI Reviewer is refining the content...'
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

export function reviewedMessage(review) {
  return {
    role: 'assistant',
    content: review.reviewed,
    type: 'reviewedContent',
    reviewId: review.reviewId,
    action: review.action
  };
}

// Normalises the raw ChromaDB `get` result into an array of version objects.
export function toVersionList(data) {
  if (!data || !data.ids || !data.metadatas || !data.documents) return [];
  return data.ids.map((id, i) => ({
    id,
    parent_version: data.metadatas[i]?.parent_version || '',
    content: data.documents[i] || '',
    timestamp: data.metadatas[i]?.timestamp || 0,
    editor: data.metadatas[i]?.editor || 'user'
  }));
}

// Maps a stored screenshot path (possibly Windows-style) to a URL path segment.
export function normalizeScreenshotPath(path) {
  return String(path || '').replace(/\\/g, '/').replace(/^[./]+/, '');
}

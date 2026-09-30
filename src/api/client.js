import { apiUrl, rlUrl } from '../config';

export const DEFAULT_SPIN_PROMPT =
  'Rewrite in modern English and simplify the tone. Remove any special characters and numbers. ' +
  'Re-write the content in a way that is easy to understand and follow. Do not format the content in any way.';

async function errorMessage(res, fallback) {
  try {
    const data = await res.json();
    return data?.error || data?.fix || fallback;
  } catch (_) {
    // Backend did not return JSON; keep the generic message.
    return fallback;
  }
}

async function postJson(url, body, fallback) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(await errorMessage(res, fallback));
  return res.json();
}

// All functions below throw on failure; callers decide how to surface errors.

export const scrapeUrl = (url) => postJson(apiUrl('/scrape'), { url }, 'Scraping failed');

export const spinText = (text, prompt = DEFAULT_SPIN_PROMPT) =>
  postJson(apiUrl('/spin'), { text, prompt }, 'Spin failed');

export const saveVersion = (content, parent_version, editor = 'user') =>
  postJson(apiUrl('/version'), { content, parent_version, editor }, 'Save version failed');

export async function fetchVersionHistory() {
  const res = await fetch(apiUrl('/version/history?limit=100&offset=0'));
  if (!res.ok) throw new Error('Failed to fetch version history');
  return res.json();
}

// Calls /ask and returns route-aware response text.
export async function askWithRouting(content, history, message) {
  const data = await postJson(apiUrl('/ask'), { content, history, message }, 'Request failed');
  const routedTo = data?._routed_to || 'chat';

  const fieldByRoute = {
    chat: data?.reply,
    spin: data?.spun,
    review: data?.reviewed,
    summarize: data?.summary
  };
  const fallbackText = data?.reply || data?.spun || data?.reviewed || data?.summary;
  const text = fieldByRoute[routedTo] || fallbackText || 'AI failed to reply.';
  return { text, routedTo };
}

// RL-based reviewer.
export async function reviewContent(spunContent) {
  const data = await postJson(rlUrl('/review'), { spunContent }, 'Review failed');
  return { reviewed: data.reviewed, reviewId: data.review_id, action: data.action };
}

export async function sendFeedback(reward, reviewId) {
  const res = await fetch(rlUrl('/feedback'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reward, review_id: reviewId })
  });
  if (!res.ok) throw new Error('Feedback failed');
}

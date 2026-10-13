import { apiUrl } from '../config';

const DEFAULT_SPIN_PROMPT =
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

async function sendJson(method, url, body, fallback) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(await errorMessage(res, fallback));
  // 204 No Content (e.g. a DELETE) has no body to parse.
  return res.status === 204 ? null : res.json();
}

const postJson = (url, body, fallback) => sendJson('POST', url, body, fallback);

async function getJson(url, fallback) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(await errorMessage(res, fallback));
  return res.json();
}

// All functions below throw on failure; callers decide how to surface errors.

export const scrapeUrl = (url) => postJson(apiUrl('/scrape'), { url }, 'Scraping failed');

export const spinText = (text, prompt = DEFAULT_SPIN_PROMPT) =>
  postJson(apiUrl('/spin'), { text, prompt }, 'Spin failed');

// --- Watches ----------------------------------------------------------------

export const listWatches = () => getJson(apiUrl('/watches'), 'Could not load watches');

// alertChannels is a subset of ['email', 'rss']; left out, the backend uses RSS only.
export const createWatch = (url, frequency = 'daily', selector = null, alertChannels) =>
  postJson(apiUrl('/watches'), { url, frequency, selector, alertChannels }, 'Could not create the watch');

// Pause or resume ({ status }) and/or change alert channels ({ alertChannels }).
export const updateWatch = (id, changes) =>
  sendJson('PATCH', apiUrl(`/watches/${id}`), changes, 'Could not update the watch');

export const deleteWatch = (id) =>
  sendJson('DELETE', apiUrl(`/watches/${id}`), undefined, 'Could not delete the watch');

// Runs a check now instead of waiting for the watch's schedule.
export const checkWatch = (id) =>
  postJson(apiUrl(`/watches/${id}/check`), {}, 'Could not check the page');

// Detected changes, newest first, each with its explanation when one verified.
export const listChanges = (id) =>
  getJson(apiUrl(`/watches/${id}/changes`), 'Could not load changes');

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

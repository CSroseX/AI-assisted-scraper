import { apiUrl } from '../config';

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

// Every alert the watch queued, one per change and channel, newest first.
export const listAlerts = (id) =>
  getJson(apiUrl(`/watches/${id}/alerts`), 'Could not load alerts');

// One snapshot with its captured text.
export const getSnapshot = (watchId, snapshotId) =>
  getJson(apiUrl(`/watches/${watchId}/snapshots/${snapshotId}`), 'Could not load the snapshot');

// For an <img src>. Needs no LINK_TOKEN, which the frontend must never hold.
export const snapshotScreenshotUrl = (watchId, snapshotId) =>
  apiUrl(`/watches/${watchId}/snapshots/${snapshotId}/screenshot`);

// Rate a change 'useful' or 'noise'. The noise ratio is counted from these.
export const setFeedback = (watchId, changeId, vote) =>
  sendJson('PUT', apiUrl(`/watches/${watchId}/changes/${changeId}/feedback`), { vote }, 'Could not save the rating');

export const clearFeedback = (watchId, changeId) =>
  sendJson('DELETE', apiUrl(`/watches/${watchId}/changes/${changeId}/feedback`), undefined, 'Could not clear the rating');

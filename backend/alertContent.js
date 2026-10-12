// The words of an alert, shared by every channel (RSS, email, evidence page)
// so a change reads the same wherever the user meets it.

const { publicUrl } = require('./publicLinks');

const CATEGORY_TITLES = {
  price: 'Price change',
  fees: 'Fee change',
  cancellation: 'Cancellation terms changed',
  data_use: 'Data use terms changed',
  cosmetic: 'Wording change',
  layout_change: 'Page redesigned'
};

const NO_SUMMARY = 'This page changed. No verified summary is available yet; the changed text is below.';

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function alertTitle(category, url) {
  return `${CATEGORY_TITLES[category] || 'Change detected'} on ${hostOf(url)}`;
}

function evidenceUrl(changeId) {
  return publicUrl(`/evidence/changes/${changeId}`);
}

module.exports = { CATEGORY_TITLES, NO_SUMMARY, hostOf, alertTitle, evidenceUrl };

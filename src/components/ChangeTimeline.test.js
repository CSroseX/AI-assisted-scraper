import fs from 'fs';
import path from 'path';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ChangeTimeline from './ChangeTimeline';
import { CATEGORY_TITLES, NO_SUMMARY } from './ChangeCard';
import * as api from '../api/client';

jest.mock('../api/client', () => ({
  ...jest.requireActual('../api/client'),
  listChanges: jest.fn(),
  listAlerts: jest.fn(),
  getSnapshot: jest.fn(),
  setFeedback: jest.fn(),
  clearFeedback: jest.fn()
}));

const WATCH = { id: 7, url: 'https://a.test/pricing' };

const change = (overrides) => ({
  id: 1,
  fromSnapshotId: 10,
  toSnapshotId: 11,
  diff: [
    { type: 'removed', text: 'Pro: $10/month' },
    { type: 'added', text: 'Pro: $12/month' }
  ],
  createdAt: Date.UTC(2026, 9, 13, 12),
  category: 'price',
  summary: 'The Pro plan rose from $10 to $12 a month.',
  quotes: ['Pro: $12/month'],
  explainedAt: Date.UTC(2026, 9, 13, 12),
  explainError: null,
  feedback: null,
  ...overrides
});

beforeEach(() => {
  jest.resetAllMocks();
  api.listChanges.mockResolvedValue([change()]);
  api.listAlerts.mockResolvedValue([]);
});

async function renderTimeline(onBack = jest.fn()) {
  render(<ChangeTimeline watch={WATCH} onBack={onBack} />);
  await waitFor(() => expect(screen.queryByText('Loading changes…')).not.toBeInTheDocument());
}

test('shows each change with its category, summary, changed text and alert status', async () => {
  api.listAlerts.mockResolvedValue([
    { id: 1, changeId: 1, channel: 'rss', status: 'sent', lastError: null },
    { id: 2, changeId: 1, channel: 'email', status: 'failed', lastError: 'SMTP refused' },
    { id: 3, changeId: 99, channel: 'rss', status: 'sent', lastError: null }
  ]);
  await renderTimeline();

  expect(api.listChanges).toHaveBeenCalledWith(7);
  expect(screen.getByText('Price change')).toBeInTheDocument();
  expect(screen.getByText('The Pro plan rose from $10 to $12 a month.')).toBeInTheDocument();
  const [removed, added] = screen.getAllByRole('listitem');
  expect(removed).toHaveClass('diff-removed');
  expect(removed).toHaveTextContent('RemovedPro: $10/month');
  expect(added).toHaveClass('diff-added');
  expect(added).toHaveTextContent('AddedPro: $12/month');
  expect(screen.getByText('RSS: sent')).toBeInTheDocument();
  expect(screen.getByText('Email: failed')).toHaveAttribute('title', 'SMTP refused');
  // Alerts of other changes are not shown on this one.
  expect(screen.getAllByText(/RSS:/)).toHaveLength(1);
});

test('says so when nothing has changed yet', async () => {
  api.listChanges.mockResolvedValue([]);
  await renderTimeline();
  expect(screen.getByText(/No changes detected yet/)).toBeInTheDocument();
});

test('a failed load is shown', async () => {
  api.listChanges.mockRejectedValue(new Error('Watch not found'));
  await renderTimeline();
  expect(screen.getByRole('alert')).toHaveTextContent('Watch not found');
});

test.each([
  [{ category: 'layout_change', summary: null, explainedAt: null }, 'Page redesigned', /looks like a redesign/],
  [{ category: null, summary: null, explainedAt: null, explainError: 'timeout' }, 'Change detected', /explainer failed, so no summary was written/],
  [{ category: 'price', summary: null }, 'Price change', /could not be matched to the changed text/],
  [{ category: null, summary: null, explainedAt: null }, 'Change detected', /No verified summary is available yet; the changed text is below\.$/]
])('an unexplained change says so honestly', async (overrides, title, reason) => {
  api.listChanges.mockResolvedValue([change(overrides)]);
  await renderTimeline();
  expect(screen.getByText(title)).toBeInTheDocument();
  expect(screen.getByText(/^This page changed\. No verified summary/)).toHaveTextContent(reason);
  // The changed text is still the evidence.
  expect(screen.getByText('Pro: $12/month')).toBeInTheDocument();
});

test('a very long change shows its first paragraphs until asked for all', async () => {
  const diff = Array.from({ length: 50 }, (_, i) => ({ type: 'added', text: `Paragraph ${i + 1}` }));
  api.listChanges.mockResolvedValue([change({ diff, category: 'layout_change', summary: null })]);
  await renderTimeline();

  expect(screen.getByText('What changed (50 paragraphs)')).toBeInTheDocument();
  expect(screen.getAllByText(/^Paragraph \d+$/)).toHaveLength(6);
  userEvent.click(screen.getByRole('button', { name: 'Show all 50 paragraphs' }));
  expect(screen.getAllByText(/^Paragraph \d+$/)).toHaveLength(50);
});

test('rating saves the vote, and choosing it again clears it', async () => {
  api.setFeedback.mockResolvedValue({ changeId: 1, vote: 'useful' });
  api.clearFeedback.mockResolvedValue(null);
  await renderTimeline();
  const useful = screen.getByRole('button', { name: 'Useful' });
  expect(useful).toHaveAttribute('aria-pressed', 'false');

  userEvent.click(useful);
  await waitFor(() => expect(useful).toHaveAttribute('aria-pressed', 'true'));
  expect(api.setFeedback).toHaveBeenCalledWith(7, 1, 'useful');

  userEvent.click(useful);
  await waitFor(() => expect(useful).toHaveAttribute('aria-pressed', 'false'));
  expect(api.clearFeedback).toHaveBeenCalledWith(7, 1);
});

test('a stored rating shows after a reload', async () => {
  api.listChanges.mockResolvedValue([change({ feedback: 'noise' })]);
  await renderTimeline();
  expect(screen.getByRole('button', { name: 'Noise' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Useful' })).toHaveAttribute('aria-pressed', 'false');
});

test('a rating that fails to save is reported and not shown as saved', async () => {
  api.setFeedback.mockRejectedValue(new Error('Could not save the rating'));
  await renderTimeline();
  userEvent.click(screen.getByRole('button', { name: 'Noise' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not save the rating');
  expect(screen.getByRole('button', { name: 'Noise' })).toHaveAttribute('aria-pressed', 'false');
});

test('before and after show both screenshots, without a token, and the full texts', async () => {
  api.getSnapshot.mockImplementation(async (_watchId, id) => ({
    id,
    createdAt: Date.UTC(2026, 9, id === 10 ? 12 : 13),
    screenshotPath: id === 10 ? 'evidence/a.png' : null,
    content: id === 10 ? 'Old full text' : 'New full text'
  }));
  await renderTimeline();

  userEvent.click(screen.getByRole('button', { name: 'Show before and after' }));
  const before = await screen.findByAltText('Screenshot before the change');
  expect(api.getSnapshot).toHaveBeenCalledWith(7, 10);
  expect(api.getSnapshot).toHaveBeenCalledWith(7, 11);
  expect(before.getAttribute('src')).toMatch(/\/watches\/7\/snapshots\/10\/screenshot$/);
  expect(before.getAttribute('src')).not.toMatch(/token/);
  // The after snapshot has no screenshot, and says so.
  expect(screen.getByText('No screenshot was captured.')).toBeInTheDocument();
  expect(screen.getByText('Old full text')).toBeInTheDocument();
  expect(screen.getByText('New full text')).toBeInTheDocument();

  userEvent.click(screen.getByRole('button', { name: 'Hide before and after' }));
  expect(screen.getByText(/^Before, captured/)).not.toBeVisible();
});

test('a before/after that fails to load says why', async () => {
  api.getSnapshot.mockRejectedValue(new Error('Snapshot not found'));
  await renderTimeline();
  userEvent.click(screen.getByRole('button', { name: 'Show before and after' }));
  const card = screen.getByRole('article');
  expect(await within(card).findByRole('alert')).toHaveTextContent('Snapshot not found');
});

test('the back button returns to the list', async () => {
  const onBack = jest.fn();
  await renderTimeline(onBack);
  userEvent.click(screen.getByRole('button', { name: '← All pages' }));
  expect(onBack).toHaveBeenCalled();
});

test('changes still show when alert status fails to load', async () => {
  api.listAlerts.mockRejectedValue(new Error('Could not load alerts'));
  await renderTimeline();
  expect(screen.getByText('The Pro plan rose from $10 to $12 a month.')).toBeInTheDocument();
  expect(screen.getByText('Alert status could not be loaded.')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('Refresh picks up an explanation that landed after the timeline opened', async () => {
  api.listChanges.mockResolvedValueOnce([change({ category: null, summary: null, explainedAt: null })]);
  await renderTimeline();
  expect(screen.getByText(/^This page changed\. No verified summary/)).toBeInTheDocument();

  userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByText('The Pro plan rose from $10 to $12 a month.')).toBeInTheDocument();
  expect(api.listChanges).toHaveBeenCalledTimes(2);
});

test('a failed rating is reported on the change it belongs to', async () => {
  api.listChanges.mockResolvedValue([change({ id: 1 }), change({ id: 2, summary: 'Second change.' })]);
  api.setFeedback.mockImplementation(async (_w, changeId) => {
    if (changeId === 2) throw new Error('Could not save the rating');
    return {};
  });
  await renderTimeline();
  const [first, second] = screen.getAllByRole('article');

  userEvent.click(within(second).getByRole('button', { name: 'Noise' }));
  expect(await within(second).findByRole('alert')).toHaveTextContent('Could not save the rating');
  // Rating another change doesn't erase that failure.
  userEvent.click(within(first).getByRole('button', { name: 'Useful' }));
  await waitFor(() => expect(within(first).getByRole('button', { name: 'Useful' })).toHaveAttribute('aria-pressed', 'true'));
  expect(within(second).getByRole('alert')).toBeInTheDocument();
});

test('hiding and showing before and after again does not refetch', async () => {
  api.getSnapshot.mockImplementation(async (_watchId, id) => ({ id, createdAt: 0, screenshotPath: null, content: `Text ${id}` }));
  await renderTimeline();
  userEvent.click(screen.getByRole('button', { name: 'Show before and after' }));
  expect(await screen.findByText(/^Before, captured/)).toBeVisible();
  userEvent.click(screen.getByRole('button', { name: 'Hide before and after' }));
  expect(screen.getByText(/^Before, captured/)).not.toBeVisible();
  userEvent.click(screen.getByRole('button', { name: 'Show before and after' }));
  expect(screen.getByText(/^Before, captured/)).toBeVisible();
  expect(api.getSnapshot).toHaveBeenCalledTimes(2);
});

test('the wording matches the backend, so a change reads the same in the UI, email and RSS', () => {
  const backend = fs.readFileSync(path.join(__dirname, '../../backend/alertContent.js'), 'utf8');
  for (const [category, title] of Object.entries(CATEGORY_TITLES)) {
    expect(backend).toContain(`${category}: '${title}'`);
  }
  expect(backend).toContain(`const NO_SUMMARY = '${NO_SUMMARY}';`);
});

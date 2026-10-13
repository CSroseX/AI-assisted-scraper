import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import WatchesPage from './WatchesPage';
import * as api from '../api/client';

jest.mock('../api/client');

const watch = (overrides) => ({
  id: 1,
  url: 'https://a.test/pricing',
  selector: null,
  frequency: 'daily',
  status: 'active',
  lastCheckedAt: null,
  nextCheckAt: Date.UTC(2026, 9, 14),
  failureCount: 0,
  lastError: null,
  alertChannels: ['rss'],
  ...overrides
});

beforeEach(() => {
  jest.resetAllMocks();
  api.listWatches.mockResolvedValue([]);
});

const rowFor = (url) => screen.getAllByRole('row').find((row) => within(row).queryByRole('link', { name: url }));

async function renderPage() {
  render(<WatchesPage />);
  await waitFor(() => expect(screen.queryByText('Loading watched pages…')).not.toBeInTheDocument());
}

test('lists each watch with its schedule, status, alerts and the first line of its last error', async () => {
  api.listWatches.mockResolvedValue([
    watch({ id: 1, url: 'https://a.test/pricing', alertChannels: ['email', 'rss'], selector: '#plans' }),
    watch({
      id: 2,
      url: 'https://b.test/terms',
      frequency: 'weekly',
      status: 'broken',
      lastError: 'page.goto: net::ERR_CONNECTION_CLOSED\nCall log:\n  - navigating…'
    })
  ]);
  await renderPage();

  const a = within(rowFor('https://a.test/pricing'));
  expect(a.getByText('Daily')).toBeInTheDocument();
  expect(a.getByText('Active')).toBeInTheDocument();
  expect(a.getByText('Email, RSS')).toBeInTheDocument();
  expect(a.getByText('#plans')).toBeInTheDocument();
  expect(a.getByRole('button', { name: 'Pause' })).toBeInTheDocument();

  const b = within(rowFor('https://b.test/terms'));
  expect(b.getByText('Weekly')).toBeInTheDocument();
  expect(b.getByText('Broken')).toBeInTheDocument();
  expect(b.getByText('page.goto: net::ERR_CONNECTION_CLOSED')).toBeInTheDocument();
  expect(b.queryByText(/Call log/)).not.toBeInTheDocument();
  expect(b.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
});

test('says so when nothing is watched', async () => {
  await renderPage();
  expect(screen.getByText(/No pages are watched yet/)).toBeInTheDocument();
});

test('a failed load is shown and Reload tries again', async () => {
  api.listWatches.mockRejectedValueOnce(new Error('Could not load watches'));
  await renderPage();
  expect(screen.getByRole('alert')).toHaveTextContent('Could not load watches');

  api.listWatches.mockResolvedValue([watch()]);
  userEvent.click(screen.getByRole('button', { name: 'Reload' }));
  expect(await screen.findByRole('link', { name: 'https://a.test/pricing' })).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('adding a page sends every field and reloads the list', async () => {
  api.createWatch.mockResolvedValue(watch({ id: 5 }));
  await renderPage();

  await userEvent.type(screen.getByLabelText('Page URL'), '  https://c.test/plans ');
  userEvent.selectOptions(screen.getByLabelText('Check'), 'weekly');
  await userEvent.type(screen.getByLabelText('CSS selector (optional)'), 'main');
  userEvent.click(screen.getByLabelText('Email'));
  api.listWatches.mockResolvedValue([watch({ id: 5, url: 'https://c.test/plans' })]);
  userEvent.click(screen.getByRole('button', { name: 'Add page' }));

  expect(await screen.findByRole('link', { name: 'https://c.test/plans' })).toBeInTheDocument();
  expect(api.createWatch).toHaveBeenCalledWith('https://c.test/plans', 'weekly', 'main', ['email', 'rss']);
  expect(screen.getByLabelText('Page URL')).toHaveValue('');
  expect(screen.getByRole('status')).toHaveTextContent(/Added/);
});

test('an empty selector is sent as null', async () => {
  api.createWatch.mockResolvedValue(watch());
  await renderPage();
  await userEvent.type(screen.getByLabelText('Page URL'), 'https://c.test');
  userEvent.click(screen.getByRole('button', { name: 'Add page' }));
  await waitFor(() => expect(api.createWatch).toHaveBeenCalledWith('https://c.test', 'daily', null, ['rss']));
});

test('an invalid URL is caught before calling the API', async () => {
  await renderPage();
  await userEvent.type(screen.getByLabelText('Page URL'), 'not a url');
  userEvent.click(screen.getByRole('button', { name: 'Add page' }));
  expect(screen.getByRole('alert')).toHaveTextContent(/http:\/\/ or https:\/\//);
  expect(api.createWatch).not.toHaveBeenCalled();
});

test('the API reason for rejecting a page is shown under the form, and the input is kept', async () => {
  api.createWatch.mockRejectedValue(new Error('Requests to private or internal addresses are not allowed'));
  await renderPage();
  await userEvent.type(screen.getByLabelText('Page URL'), 'http://10.0.0.1');
  userEvent.click(screen.getByRole('button', { name: 'Add page' }));

  const form = screen.getByRole('form', { name: 'Add a page' });
  expect(await within(form).findByRole('alert')).toHaveTextContent('private or internal addresses');
  expect(screen.getByLabelText('Page URL')).toHaveValue('http://10.0.0.1');
});

test('pause and resume send the new status', async () => {
  api.listWatches.mockResolvedValue([watch({ id: 1 }), watch({ id: 2, url: 'https://b.test', status: 'paused' })]);
  api.updateWatch.mockResolvedValue({});
  await renderPage();

  userEvent.click(within(rowFor('https://a.test/pricing')).getByRole('button', { name: 'Pause' }));
  await waitFor(() => expect(api.updateWatch).toHaveBeenCalledWith(1, { status: 'paused' }));
  await screen.findAllByRole('button', { name: 'Check now' });

  userEvent.click(within(rowFor('https://b.test')).getByRole('button', { name: 'Resume' }));
  await waitFor(() => expect(api.updateWatch).toHaveBeenCalledWith(2, { status: 'active' }));
});

test('delete asks first and does nothing when cancelled', async () => {
  api.listWatches.mockResolvedValue([watch()]);
  api.deleteWatch.mockResolvedValue();
  await renderPage();

  window.confirm = jest.fn(() => false);
  userEvent.click(screen.getByRole('button', { name: 'Delete' }));
  expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('https://a.test/pricing'));
  expect(api.deleteWatch).not.toHaveBeenCalled();

  window.confirm = jest.fn(() => true);
  api.listWatches.mockResolvedValue([]);
  userEvent.click(screen.getByRole('button', { name: 'Delete' }));
  expect(await screen.findByText(/No pages are watched yet/)).toBeInTheDocument();
  expect(api.deleteWatch).toHaveBeenCalledWith(1);
});

test.each([
  [{ changed: false, change: null }, /No change since the last snapshot/],
  [{ changed: true, change: null }, /Saved a new snapshot.*first snapshot, or the change was only noise/],
  [{ changed: true, change: { id: 9 } }, /A change was detected/]
])('check now reports what it found', async (result, message) => {
  api.listWatches.mockResolvedValue([watch()]);
  api.checkWatch.mockResolvedValue(result);
  await renderPage();

  userEvent.click(screen.getByRole('button', { name: 'Check now' }));
  expect(await screen.findByText(message)).toHaveTextContent('https://a.test/pricing:');
  expect(api.checkWatch).toHaveBeenCalledWith(1);
});

test('a failed action is shown, not swallowed, even after the list reloads', async () => {
  api.listWatches.mockResolvedValue([watch()]);
  api.checkWatch.mockRejectedValue(new Error('This page is already being checked, please retry shortly.'));
  await renderPage();

  userEvent.click(screen.getByRole('button', { name: 'Check now' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('already being checked');
  expect(api.listWatches).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('button', { name: 'Check now' })).toBeInTheDocument();
});

test('an older list reply arriving last cannot bring back a deleted watch', async () => {
  const a = watch({ id: 1, url: 'https://a.test' });
  const b = watch({ id: 2, url: 'https://b.test' });
  api.listWatches.mockResolvedValue([a, b]);
  await renderPage();

  // Pause A, and hold its reload until after B is deleted.
  let releaseStaleReload;
  api.updateWatch.mockResolvedValue({});
  api.listWatches.mockImplementationOnce(() => new Promise((resolve) => {
    releaseStaleReload = () => resolve([a, b]);
  }));
  userEvent.click(within(rowFor('https://a.test')).getByRole('button', { name: 'Pause' }));
  await waitFor(() => expect(releaseStaleReload).toBeDefined());

  window.confirm = jest.fn(() => true);
  api.deleteWatch.mockResolvedValue(null);
  api.listWatches.mockResolvedValueOnce([a]);
  userEvent.click(within(rowFor('https://b.test')).getByRole('button', { name: 'Delete' }));
  await waitFor(() => expect(screen.queryByRole('link', { name: 'https://b.test' })).not.toBeInTheDocument());

  releaseStaleReload();
  await screen.findByRole('button', { name: 'Pause' });
  expect(screen.queryByRole('link', { name: 'https://b.test' })).not.toBeInTheDocument();
});

test('a successful add clears an earlier error', async () => {
  api.listWatches.mockRejectedValueOnce(new Error('Could not load watches'));
  api.createWatch.mockResolvedValue(watch());
  await renderPage();
  expect(screen.getByRole('alert')).toHaveTextContent('Could not load watches');

  await userEvent.type(screen.getByLabelText('Page URL'), 'https://a.test/pricing');
  userEvent.click(screen.getByRole('button', { name: 'Add page' }));
  expect(await screen.findByRole('status')).toHaveTextContent('Added https://a.test/pricing');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

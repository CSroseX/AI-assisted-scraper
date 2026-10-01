import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import * as api from './api/client';

// react-markdown is ESM-only and not needed to verify behaviour.
jest.mock('react-markdown', () => ({ __esModule: true, default: ({ children }) => <div>{children}</div> }));
jest.mock('remark-gfm', () => ({ __esModule: true, default: () => {} }));
jest.mock('./api/client');

const versionsPayload = (n) => ({
  ids: Array.from({ length: n }, (_, i) => `id${i}`),
  documents: Array.from({ length: n }, (_, i) => `version ${i}`),
  metadatas: Array.from({ length: n }, () => ({ parent_version: '', timestamp: 1700000000, editor: 'ai-writer' }))
});

beforeEach(() => {
  jest.resetAllMocks();
  window.alert = jest.fn();
  api.fetchVersionHistory.mockResolvedValue(versionsPayload(0));
  api.scrapeUrl.mockResolvedValue({ content: 'scraped page text', screenshotPath: 'screenshots/a.png' });
  api.spinText.mockResolvedValue({ spun: 'spun page text' });
  api.saveVersion.mockResolvedValue({ id: 'v1' });
  api.reviewContent.mockResolvedValue({ reviewed: 'Concise review: fine', reviewId: 'rev-1', action: 0 });
  api.askWithRouting.mockResolvedValue({ text: 'It is about testing.', routedTo: 'chat' });
  api.sendFeedback.mockResolvedValue(undefined);
});

// Waits for the on-mount version-history fetch so its state update happens inside act().
async function renderApp() {
  render(<App />);
  await waitFor(() => expect(api.fetchVersionHistory).toHaveBeenCalled());
  await screen.findByText('Enter Page URL');
}

async function submitUrl(url = 'https://example.com') {
  await userEvent.type(screen.getByPlaceholderText('https://example.com'), url);
  userEvent.click(screen.getByRole('button', { name: 'Submit' }));
}

test('asks for a URL on load and rejects invalid ones', async () => {
  await renderApp();
  expect(screen.getByText('Enter Page URL')).toBeInTheDocument();
  await userEvent.type(screen.getByPlaceholderText('https://example.com'), 'not a url');
  userEvent.click(screen.getByRole('button', { name: 'Submit' }));
  expect(screen.getByText('Please insert a valid URL')).toBeInTheDocument();
  expect(api.scrapeUrl).not.toHaveBeenCalled();
});

test('scrape -> AI Writer -> AI Reviewer pipeline populates the chat', async () => {
  await renderApp();
  await submitUrl();

  expect(await screen.findByText('spun page text')).toBeInTheDocument();
  expect(await screen.findByText('Concise review: fine')).toBeInTheDocument();
  expect(screen.getByText('URL accepted.')).toBeInTheDocument();
  expect(screen.queryByText('Enter Page URL')).not.toBeInTheDocument();

  expect(api.scrapeUrl).toHaveBeenCalledWith('https://example.com');
  expect(api.spinText).toHaveBeenCalledWith('scraped page text');
  expect(api.saveVersion).toHaveBeenCalledWith('spun page text', null, 'ai-writer');
  expect(api.reviewContent).toHaveBeenCalledWith('spun page text');
  expect(screen.getByRole('button', { name: /see screenshot/i })).toBeInTheDocument();
});

test('a failed scrape shows an error message and offers no page options', async () => {
  api.scrapeUrl.mockRejectedValue(new Error('Only http and https URLs are allowed'));
  await renderApp();
  await submitUrl();

  expect(await screen.findByText('Failed to scrape the URL.')).toBeInTheDocument();
  expect(window.alert).toHaveBeenCalledWith('Error: Only http and https URLs are allowed');
  expect(api.spinText).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: /see screenshot/i })).not.toBeInTheDocument();
});

test('a failed spin reports it and skips versioning and review', async () => {
  api.spinText.mockRejectedValue(new Error('Spin failed'));
  await renderApp();
  await submitUrl();

  expect(await screen.findByText('Failed to spin content.')).toBeInTheDocument();
  expect(api.saveVersion).not.toHaveBeenCalled();
  expect(api.reviewContent).not.toHaveBeenCalled();
});

test('chat questions use the scraped content and history, and record the route', async () => {
  await renderApp();
  await submitUrl();
  await screen.findByText('Concise review: fine');

  await userEvent.type(screen.getByPlaceholderText('Type your message...'), 'what is this about?');
  userEvent.click(screen.getByRole('button', { name: 'Send' }));

  expect(await screen.findByText('It is about testing.')).toBeInTheDocument();
  expect(api.askWithRouting).toHaveBeenCalledWith('scraped page text', expect.any(Array), 'what is this about?');
  expect(screen.queryByText('Thinking...')).not.toBeInTheDocument();

  userEvent.click(screen.getByTitle('Show notifications'));
  expect(screen.getByText('Routed to: chat')).toBeInTheDocument();
});

test('editing the AI Writer output saves a version and re-runs the reviewer', async () => {
  await renderApp();
  await submitUrl();
  await screen.findByText('Concise review: fine');

  userEvent.click(screen.getByTitle('Edit spun content'));
  const textarea = screen.getByDisplayValue('spun page text');
  const save = screen.getByRole('button', { name: 'Save' });
  expect(save).toBeDisabled(); // unchanged text cannot be saved

  api.reviewContent.mockResolvedValue({ reviewed: 'Detailed review: better', reviewId: 'rev-2', action: 1 });
  await userEvent.clear(textarea);
  await userEvent.type(textarea, 'edited text');
  userEvent.click(screen.getByRole('button', { name: 'Save' }));

  expect(await screen.findByText('Detailed review: better')).toBeInTheDocument();
  expect(screen.getByText('edited text')).toBeInTheDocument();
  expect(screen.queryByText('Concise review: fine')).not.toBeInTheDocument();
  expect(api.saveVersion).toHaveBeenLastCalledWith('edited text', null, 'ai-writer');
  expect(api.reviewContent).toHaveBeenLastCalledWith('edited text');
});

test('cancelling an edit restores the original message', async () => {
  await renderApp();
  await submitUrl();
  await screen.findByText('Concise review: fine');

  userEvent.click(screen.getByTitle('Edit spun content'));
  userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByText('spun page text')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
});

test('a failed reviewer run after an edit shows a failure message instead of hanging', async () => {
  await renderApp();
  await submitUrl();
  await screen.findByText('Concise review: fine');

  userEvent.click(screen.getByTitle('Edit spun content'));
  api.reviewContent.mockRejectedValue(new Error('Review failed'));
  await userEvent.type(screen.getByDisplayValue('spun page text'), ' more');
  userEvent.click(screen.getByRole('button', { name: 'Save' }));

  expect(await screen.findByText('AI Reviewer failed to reply.')).toBeInTheDocument();
  expect(screen.queryByText('AI Reviewer is refining the content...')).not.toBeInTheDocument();
});

test('thumbs feedback is sent with the current review id and disables further votes', async () => {
  await renderApp();
  await submitUrl();
  await screen.findByText('Concise review: fine');

  userEvent.click(screen.getByTitle('Thumbs Up'));
  await waitFor(() => expect(api.sendFeedback).toHaveBeenCalledWith(1, 'rev-1'));
  expect(await screen.findByText(/Marked as helpful/)).toBeInTheDocument();
  expect(screen.getByTitle('Thumbs Up')).toBeDisabled();
  expect(screen.getByTitle('Thumbs Down')).toBeDisabled();
});

test('thumbs down sends a negative reward', async () => {
  await renderApp();
  await submitUrl();
  await screen.findByText('Concise review: fine');

  userEvent.click(screen.getByTitle('Thumbs Down'));
  await waitFor(() => expect(api.sendFeedback).toHaveBeenCalledWith(-1, 'rev-1'));
});

test('a feedback failure is reported without crashing', async () => {
  api.sendFeedback.mockRejectedValue(new Error('down'));
  await renderApp();
  await submitUrl();
  await screen.findByText('Concise review: fine');

  userEvent.click(screen.getByTitle('Thumbs Up'));
  expect(await screen.findByText('Could not send feedback to the review service.')).toBeInTheDocument();
});

test('page options open and close the screenshot, scraped data and history modals', async () => {
  api.fetchVersionHistory.mockResolvedValue(versionsPayload(2));
  await renderApp();
  await submitUrl();
  await screen.findByText('Concise review: fine');

  userEvent.click(screen.getByRole('button', { name: /see scraped data/i }));
  expect(screen.getByText('scraped page text')).toBeInTheDocument();
  userEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByText('scraped page text')).not.toBeInTheDocument();

  userEvent.click(screen.getByRole('button', { name: /see screenshot/i }));
  expect(screen.getByAltText('Screenshot').getAttribute('src')).toMatch(/\/screenshots\/a\.png$/);
  userEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByAltText('Screenshot')).not.toBeInTheDocument();

  userEvent.click(screen.getByRole('button', { name: /version history/i }));
  const dialog = screen.getByRole('dialog', { name: 'Version history' });
  expect(within(dialog).getAllByText(/by ai-writer/)).toHaveLength(2);
  userEvent.click(within(dialog).getByText(/^v2/));
  expect(within(dialog).getByText('version 1')).toBeInTheDocument();
});

test('new chats prompt for a URL, keep sessions independent and can be deleted', async () => {
  await renderApp();
  await submitUrl();
  await screen.findByText('Concise review: fine');

  userEvent.click(screen.getByRole('button', { name: '+ New Chat' }));
  expect(screen.getByText('Enter Page URL')).toBeInTheDocument();
  expect(screen.getByText('Chat 2')).toBeInTheDocument();
  expect(screen.queryByText('Concise review: fine')).not.toBeInTheDocument();

  // Switch back to chat 1 by clicking it in the sidebar; its history is intact.
  userEvent.click(screen.getByText('Chat 1'));
  expect(await screen.findByText('Concise review: fine')).toBeInTheDocument();
});

test('asking without scraped content explains what is needed', async () => {
  api.scrapeUrl.mockRejectedValue(new Error('nope'));
  await renderApp();
  await submitUrl();
  await screen.findByText('Failed to scrape the URL.');

  await userEvent.type(screen.getByPlaceholderText('Type your message...'), 'hello');
  userEvent.click(screen.getByRole('button', { name: 'Send' }));
  expect(await screen.findByText(/No scraped content is available yet/)).toBeInTheDocument();
  expect(api.askWithRouting).not.toHaveBeenCalled();
});

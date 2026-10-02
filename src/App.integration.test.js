import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';
import * as api from './api/client';

// react-markdown is ESM-only and not needed to verify behaviour.
jest.mock('react-markdown', () => ({ __esModule: true, default: ({ children }) => <div>{children}</div> }));
jest.mock('remark-gfm', () => ({ __esModule: true, default: () => {} }));
jest.mock('./api/client');

beforeEach(() => {
  jest.resetAllMocks();
  window.alert = jest.fn();
  api.scrapeUrl.mockResolvedValue({ content: 'scraped page text', screenshotPath: 'screenshots/a.png' });
  api.spinText.mockResolvedValue({ spun: 'spun page text' });
  api.askWithRouting.mockResolvedValue({ text: 'It is about testing.', routedTo: 'chat' });
});

async function renderApp() {
  render(<App />);
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

test('scrape -> AI Writer pipeline populates the chat', async () => {
  await renderApp();
  await submitUrl();

  expect(await screen.findByText('spun page text')).toBeInTheDocument();
  expect(screen.getByText('URL accepted.')).toBeInTheDocument();
  expect(screen.queryByText('Enter Page URL')).not.toBeInTheDocument();

  expect(api.scrapeUrl).toHaveBeenCalledWith('https://example.com');
  expect(api.spinText).toHaveBeenCalledWith('scraped page text');
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

test('a failed spin reports it', async () => {
  api.spinText.mockRejectedValue(new Error('Spin failed'));
  await renderApp();
  await submitUrl();

  expect(await screen.findByText('Failed to spin content.')).toBeInTheDocument();
});

test('chat questions use the scraped content and history, and record the route', async () => {
  await renderApp();
  await submitUrl();
  await screen.findByText('spun page text');

  await userEvent.type(screen.getByPlaceholderText('Type your message...'), 'what is this about?');
  userEvent.click(screen.getByRole('button', { name: 'Send' }));

  expect(await screen.findByText('It is about testing.')).toBeInTheDocument();
  expect(api.askWithRouting).toHaveBeenCalledWith('scraped page text', expect.any(Array), 'what is this about?');
  expect(screen.queryByText('Thinking...')).not.toBeInTheDocument();

  userEvent.click(screen.getByTitle('Show notifications'));
  expect(screen.getByText('Routed to: chat')).toBeInTheDocument();
});

test('editing the AI Writer output updates the message in place', async () => {
  await renderApp();
  await submitUrl();
  await screen.findByText('spun page text');

  userEvent.click(screen.getByTitle('Edit spun content'));
  const textarea = screen.getByDisplayValue('spun page text');
  const save = screen.getByRole('button', { name: 'Save' });
  expect(save).toBeDisabled(); // unchanged text cannot be saved

  await userEvent.clear(textarea);
  await userEvent.type(textarea, 'edited text');
  userEvent.click(screen.getByRole('button', { name: 'Save' }));

  expect(await screen.findByText('edited text')).toBeInTheDocument();
  expect(screen.queryByText('spun page text')).not.toBeInTheDocument();
});

test('cancelling an edit restores the original message', async () => {
  await renderApp();
  await submitUrl();
  await screen.findByText('spun page text');

  userEvent.click(screen.getByTitle('Edit spun content'));
  userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByText('spun page text')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
});

test('page options open and close the screenshot and scraped data modals', async () => {
  await renderApp();
  await submitUrl();
  await screen.findByText('spun page text');

  userEvent.click(screen.getByRole('button', { name: /see scraped data/i }));
  expect(screen.getByText('scraped page text')).toBeInTheDocument();
  userEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByText('scraped page text')).not.toBeInTheDocument();

  userEvent.click(screen.getByRole('button', { name: /see screenshot/i }));
  expect(screen.getByAltText('Screenshot').getAttribute('src')).toMatch(/\/screenshots\/a\.png$/);
  userEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByAltText('Screenshot')).not.toBeInTheDocument();
});

test('new chats prompt for a URL, keep sessions independent and can be deleted', async () => {
  await renderApp();
  await submitUrl();
  await screen.findByText('spun page text');

  userEvent.click(screen.getByRole('button', { name: '+ New Chat' }));
  expect(screen.getByText('Enter Page URL')).toBeInTheDocument();
  expect(screen.getByText('Chat 2')).toBeInTheDocument();
  expect(screen.queryByText('spun page text')).not.toBeInTheDocument();

  // Switch back to chat 1 by clicking it in the sidebar; its history is intact.
  userEvent.click(screen.getByText('Chat 1'));
  expect(await screen.findByText('spun page text')).toBeInTheDocument();
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

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App';

jest.mock('./Chat', () => () => <div>Chat Mock</div>);
jest.mock('./Sidebar', () => () => <div>Sidebar Mock</div>);
jest.mock('./UrlModal', () => () => <div>UrlModal Mock</div>);
jest.mock('./components/WatchesPage', () => () => <div>WatchesPage Mock</div>);

test('opens on the watched pages view', () => {
  render(<App />);
  expect(screen.getByText('WatchesPage Mock')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Watched pages' })).toHaveAttribute('aria-current', 'page');
  expect(screen.queryByRole('button', { name: /new chat/i })).not.toBeInTheDocument();
});

test('the nav switches to the chat demo and back', () => {
  render(<App />);
  userEvent.click(screen.getByRole('button', { name: 'Chat demo' }));
  expect(screen.getByRole('button', { name: /new chat/i })).toBeInTheDocument();
  expect(screen.getByText(/AI Assisted scraper/i)).toBeVisible();
  expect(screen.getByText('WatchesPage Mock')).not.toBeVisible();

  userEvent.click(screen.getByRole('button', { name: 'Watched pages' }));
  expect(screen.getByText('WatchesPage Mock')).toBeVisible();
  expect(screen.getByText(/AI Assisted scraper/i)).not.toBeVisible();
});

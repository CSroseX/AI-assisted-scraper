import { render, screen } from '@testing-library/react';
import App from './App';

jest.mock('./Chat', () => () => <div>Chat Mock</div>);
jest.mock('./Sidebar', () => () => <div>Sidebar Mock</div>);
jest.mock('./UrlModal', () => () => <div>UrlModal Mock</div>);

test('renders app title and new chat button', () => {
  render(<App />);
  expect(screen.getByRole('button', { name: /new chat/i })).toBeInTheDocument();
  expect(screen.getByText(/AI Assisted scraper/i)).toBeInTheDocument();
});

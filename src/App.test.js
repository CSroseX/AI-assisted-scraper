import { render, screen } from '@testing-library/react';
import App from './App';

jest.mock('./components/WatchesPage', () => () => <div>WatchesPage Mock</div>);

test('the app is the watched pages screen', () => {
  render(<App />);
  expect(screen.getByText('Watchdog')).toBeInTheDocument();
  expect(screen.getByText('WatchesPage Mock')).toBeInTheDocument();
});

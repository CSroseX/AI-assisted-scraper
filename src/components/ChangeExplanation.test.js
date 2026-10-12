import { render, screen } from '@testing-library/react';
import ChangeExplanation from './ChangeExplanation';

test('shows the category, the summary and the quoted evidence', () => {
  render(
    <ChangeExplanation
      category="price"
      summary="The monthly price rose from $10 to $12."
      quotes={['Price: $10/month.', 'Price: $12/month.']}
    />
  );

  expect(screen.getByText('Price')).toBeInTheDocument();
  expect(screen.getByText('The monthly price rose from $10 to $12.')).toBeInTheDocument();
  expect(screen.getByText('Price: $10/month.')).toBeInTheDocument();
  expect(screen.getByText('Price: $12/month.')).toBeInTheDocument();
});

test('an unexplained change still shows its evidence rather than nothing', () => {
  render(<ChangeExplanation category={null} summary={null} quotes={['Cancellation fee: $25.']} />);

  expect(screen.getByText(/no verified explanation is available/i)).toBeInTheDocument();
  // The diff proved the change, so the text must still be visible.
  expect(screen.getByText('Cancellation fee: $25.')).toBeInTheDocument();
  expect(screen.getByText(/uncategorised/i)).toBeInTheDocument();
});

test('mentions the explainer being unreachable when that is why', () => {
  render(<ChangeExplanation summary={null} quotes={[]} explainError="connect ECONNREFUSED" />);
  expect(screen.getByText(/could not be reached/i)).toBeInTheDocument();
});

test('renders without quotes', () => {
  render(<ChangeExplanation category="layout_change" summary="The page was redesigned." quotes={[]} />);
  expect(screen.getByText('Layout change')).toBeInTheDocument();
  expect(screen.queryByText(/from the page/i)).not.toBeInTheDocument();
});

test('labels each known category', () => {
  const labels = {
    price: 'Price',
    fees: 'Fees',
    cancellation: 'Cancellation',
    data_use: 'Data use',
    cosmetic: 'Cosmetic'
  };

  for (const [category, label] of Object.entries(labels)) {
    const { unmount } = render(<ChangeExplanation category={category} summary="x" quotes={[]} />);
    expect(screen.getByText(label)).toBeInTheDocument();
    unmount();
  }
});

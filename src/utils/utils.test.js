import { isValidUrl } from './url';

describe('isValidUrl', () => {
  test.each(['http://example.com', 'https://example.com/path?q=1'])('accepts %s', (url) => {
    expect(isValidUrl(url)).toBe(true);
  });

  test.each(['', 'example.com', 'ftp://example.com', `${'java'}script:alert(1)`, 'file:///etc/passwd'])(
    'rejects %p',
    (url) => {
      expect(isValidUrl(url)).toBe(false);
    }
  );
});

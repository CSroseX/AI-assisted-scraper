import { isValidUrl } from './url';
import { normalizeAssistantMarkdown } from './markdown';
import {
  findLastIndexByType,
  normalizeScreenshotPath,
  replaceTrailingLoader
} from './messages';

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

describe('normalizeAssistantMarkdown', () => {
  test('leaves ordinary text and proper tables alone', () => {
    expect(normalizeAssistantMarkdown('plain text')).toBe('plain text');
    const table = '| a | b |\n|---|---|\n| 1 | 2 |';
    expect(normalizeAssistantMarkdown(table)).toBe(table);
  });

  test('handles null/undefined', () => {
    expect(normalizeAssistantMarkdown(undefined)).toBe('');
    expect(normalizeAssistantMarkdown(null)).toBe('');
  });

  test('splits a table that was flattened onto one line', () => {
    const out = normalizeAssistantMarkdown('| h1 | h2 | |---|---| | r1 | r2 |');
    expect(out.split('\n')).toEqual(['| h1 | h2 |', '|---|---|', '| r1 | r2 |']);
  });
});

describe('message helpers', () => {
  test('findLastIndexByType returns the last match or -1', () => {
    const msgs = [{ type: 'a' }, { type: 'b' }, { type: 'a' }];
    expect(findLastIndexByType(msgs, 'a')).toBe(2);
    expect(findLastIndexByType(msgs, 'b')).toBe(1);
    expect(findLastIndexByType(msgs, 'zzz')).toBe(-1);
    expect(findLastIndexByType([], 'a')).toBe(-1);
  });

  test('replaceTrailingLoader only replaces a matching last message', () => {
    const msgs = [{ content: 'hi' }, { content: 'Thinking...' }];
    expect(replaceTrailingLoader(msgs, 'Thinking...', { content: 'done' })).toEqual([{ content: 'hi' }, { content: 'done' }]);
    expect(replaceTrailingLoader(msgs, 'other', { content: 'done' })).toBe(msgs);
    expect(replaceTrailingLoader([], 'x', { content: 'done' })).toEqual([]);
  });

  test('normalizeScreenshotPath handles Windows separators and leading dots', () => {
    expect(normalizeScreenshotPath('screenshots/a.png')).toBe('screenshots/a.png');
    expect(normalizeScreenshotPath('.\\screenshots\\a.png')).toBe('screenshots/a.png');
    expect(normalizeScreenshotPath('../screenshots/a.png')).toBe('screenshots/a.png');
    expect(normalizeScreenshotPath(undefined)).toBe('');
  });
});

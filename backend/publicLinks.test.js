const test = require('node:test');
const assert = require('node:assert/strict');

const { publicBaseUrl, publicUrl, escapeMarkup } = require('./publicLinks');

function withEnv(t, vars) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

test('publicBaseUrl defaults to localhost on PORT and drops trailing slashes', (t) => {
  withEnv(t, { PUBLIC_BASE_URL: undefined, PORT: '5123' });
  assert.equal(publicBaseUrl(), 'http://localhost:5123');
  withEnv(t, { PUBLIC_BASE_URL: 'https://watch.example.com//' });
  assert.equal(publicBaseUrl(), 'https://watch.example.com');
});

test('publicUrl attaches the token, encoded', (t) => {
  withEnv(t, { PUBLIC_BASE_URL: 'https://w.example', LINK_TOKEN: 'a b&c' });
  assert.equal(publicUrl('/feed.xml'), 'https://w.example/feed.xml?token=a%20b%26c');
});

test('escapeMarkup escapes the five specials and drops characters XML forbids', () => {
  assert.equal(escapeMarkup(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&apos;&amp;&apos;&lt;/a&gt;');
  assert.equal(escapeMarkup('ok\u0000\u001F￾'), 'ok');
  assert.equal(escapeMarkup('tab\tnewline\n'), 'tab\tnewline\n', 'tab and newline are allowed');
  assert.equal(escapeMarkup(null), '');
});

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isPrivateIPv4,
  isPrivateIPv6,
  extractMappedIPv4,
  validateHostname,
  validateScrapeUrl,
  createGuardProxy
} = require('./ssrf');

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const privateLookup = async () => [{ address: '10.1.2.3', family: 4 }];
const mixedLookup = async () => [
  { address: '93.184.216.34', family: 4 },
  { address: '169.254.169.254', family: 4 }
];

test('isPrivateIPv4 blocks reserved ranges including metadata and CGNAT', () => {
  for (const ip of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254',
    '172.16.5.10', '172.31.255.255', '192.168.1.8', '224.0.0.1', '255.255.255.255']) {
    assert.equal(isPrivateIPv4(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '93.184.216.34', '172.32.0.1', '100.128.0.1']) {
    assert.equal(isPrivateIPv4(ip), false, ip);
  }
  assert.equal(isPrivateIPv4('not-an-ip'), true);
});

test('isPrivateIPv6 blocks reserved ranges and IPv4-mapped private addresses', () => {
  for (const ip of ['::1', '::', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1',
    '::ffff:10.0.0.1', '::ffff:a00:1', '::ffff:127.0.0.1', '::ffff:7f00:1',
    '[::1]', '64:ff9b::a00:1']) {
    assert.equal(isPrivateIPv6(ip), true, ip);
  }
  assert.equal(isPrivateIPv6('2001:4860:4860::8888'), false);
  assert.equal(isPrivateIPv6('::ffff:8.8.8.8'), false);
});

test('extractMappedIPv4 handles dotted and hex forms', () => {
  assert.equal(extractMappedIPv4('::ffff:10.0.0.1'), '10.0.0.1');
  assert.equal(extractMappedIPv4('::ffff:a00:1'), '10.0.0.1');
  assert.equal(extractMappedIPv4('2001:db8::1'), null);
});

test('validateHostname rejects hosts where any resolved address is private', async () => {
  assert.equal((await validateHostname('example.com', publicLookup)).ok, true);
  assert.equal((await validateHostname('evil.example', privateLookup)).ok, false);
  assert.equal((await validateHostname('mixed.example', mixedLookup)).ok, false);
  assert.equal((await validateHostname('gone.example', async () => { throw new Error('ENOTFOUND'); })).ok, false);
});

test('validateHostname rejects internal names and IP literals without DNS', async () => {
  const noDns = async () => { throw new Error('DNS should not be called'); };
  for (const host of ['localhost', 'app.localhost', 'printer.local', 'db.internal', '[::1]',
    '127.0.0.1', '169.254.169.254', '[::ffff:a00:1]']) {
    assert.equal((await validateHostname(host, noDns)).ok, false, host);
  }
  assert.equal((await validateHostname('8.8.8.8', noDns)).ok, true);
});

test('validateScrapeUrl blocks bad schemes, credentials and obfuscated loopback', async () => {
  const opts = { lookup: publicLookup };
  assert.equal((await validateScrapeUrl('file:///etc/passwd', opts)).ok, false);
  assert.equal((await validateScrapeUrl('ftp://example.com', opts)).ok, false);
  assert.equal((await validateScrapeUrl('https://user:pass@example.com', opts)).ok, false);
  assert.equal((await validateScrapeUrl('http://2130706433/', opts)).ok, false); // decimal 127.0.0.1
  assert.equal((await validateScrapeUrl('http://0x7f.1/', opts)).ok, false); // hex loopback
  assert.equal((await validateScrapeUrl('http://[::ffff:127.0.0.1]/', opts)).ok, false);
  assert.equal((await validateScrapeUrl('not a url', opts)).ok, false);
  assert.equal((await validateScrapeUrl('https://example.com/path', opts)).ok, true);
});

// --- Egress proxy -----------------------------------------------------------

const http = require('http');
const net = require('net');

async function withProxy(options, fn) {
  const target = http.createServer((req, res) => {
    if (req.url === '/redir') {
      res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data' });
      return res.end();
    }
    res.end('hello from target');
  });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const targetPort = target.address().port;
  const proxy = createGuardProxy({
    dial: () => net.connect({ host: '127.0.0.1', port: targetPort }), // test hook: land on local server
    ...options
  });
  const proxyPort = await proxy.listen();
  try {
    await fn({ proxyPort, targetPort });
  } finally {
    await proxy.close();
    await new Promise((r) => { target.close(r); target.closeAllConnections?.(); });
  }
}

function rawRequest(port, payload) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    socket.on('data', (d) => { data += d; });
    socket.on('close', () => resolve(data));
    socket.on('error', () => resolve(data));
    socket.write(payload);
    setTimeout(() => socket.destroy(), 1500);
  });
}

const lookupByHost = (map) => async (host) => [{ address: map[host] || host, family: 4 }];

test('proxy refuses CONNECT to private IP literals and to hosts resolving privately', async () => {
  await withProxy({ lookup: lookupByHost({ 'rebind.test': '10.0.0.7' }) }, async ({ proxyPort }) => {
    for (const host of ['127.0.0.1:80', '169.254.169.254:80', '[::1]:80', '[::ffff:7f00:1]:80', 'rebind.test:443']) {
      const reply = await rawRequest(proxyPort, `CONNECT ${host} HTTP/1.1\r\nHost: ${host}\r\n\r\n`);
      assert.match(reply, /^HTTP\/1\.1 403/, host);
    }
  });
});

test('proxy tunnels CONNECT to public hosts', async () => {
  await withProxy({ lookup: lookupByHost({ 'public.test': '93.184.216.34' }) }, async ({ proxyPort }) => {
    const reply = await rawRequest(
      proxyPort,
      'CONNECT public.test:80 HTTP/1.1\r\nHost: public.test:80\r\n\r\nGET / HTTP/1.1\r\nHost: public.test\r\nConnection: close\r\n\r\n'
    );
    assert.match(reply, /^HTTP\/1\.1 200 Connection Established/);
    assert.match(reply, /hello from target/);
  });
});

test('proxy drops plain-HTTP requests to private targets without responding', async () => {
  await withProxy({ lookup: lookupByHost({}) }, async ({ proxyPort, targetPort }) => {
    const reply = await rawRequest(
      proxyPort,
      `GET http://127.0.0.1:${targetPort}/ HTTP/1.1\r\nHost: 127.0.0.1:${targetPort}\r\nConnection: close\r\n\r\n`
    );
    assert.equal(reply, '');
  });
});

test('proxy forwards public plain-HTTP requests and passes redirects back to the client for re-validation', async () => {
  await withProxy({ lookup: lookupByHost({ 'public.test': '93.184.216.34' }) }, async ({ proxyPort }) => {
    const ok = await rawRequest(proxyPort, 'GET http://public.test/ HTTP/1.1\r\nHost: public.test\r\nConnection: close\r\n\r\n');
    assert.match(ok, /hello from target/);

    // The proxy does not follow the 302 itself; the browser's follow-up request
    // to 169.254.169.254 is a new proxy request, which is refused.
    const redirect = await rawRequest(proxyPort, 'GET http://public.test/redir HTTP/1.1\r\nHost: public.test\r\nConnection: close\r\n\r\n');
    assert.match(redirect, /^HTTP\/1\.1 302/);
    const followUp = await rawRequest(
      proxyPort,
      'GET http://169.254.169.254/latest/meta-data HTTP/1.1\r\nHost: 169.254.169.254\r\nConnection: close\r\n\r\n'
    );
    assert.equal(followUp, '');
  });
});

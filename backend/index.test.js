const test = require('node:test');
const assert = require('node:assert/strict');

const { isPrivateIPv4, isPrivateIPv6, validateScrapeUrl } = require('./index');

test('isPrivateIPv4 detects private/loopback ranges', () => {
  assert.equal(isPrivateIPv4('10.0.0.1'), true);
  assert.equal(isPrivateIPv4('172.16.5.10'), true);
  assert.equal(isPrivateIPv4('192.168.1.8'), true);
  assert.equal(isPrivateIPv4('127.0.0.1'), true);
  assert.equal(isPrivateIPv4('8.8.8.8'), false);
});

test('isPrivateIPv6 detects private/loopback ranges', () => {
  assert.equal(isPrivateIPv6('::1'), true);
  assert.equal(isPrivateIPv6('fc00::1'), true);
  assert.equal(isPrivateIPv6('fd12::1'), true);
  assert.equal(isPrivateIPv6('fe80::1'), true);
  assert.equal(isPrivateIPv6('2001:4860:4860::8888'), false);
});

test('validateScrapeUrl blocks localhost and non-http protocols', async () => {
  const blockedLocal = await validateScrapeUrl('http://localhost:5000');
  assert.equal(blockedLocal.ok, false);

  const blockedProto = await validateScrapeUrl('file:///etc/passwd');
  assert.equal(blockedProto.ok, false);
});

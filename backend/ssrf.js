const dns = require('dns').promises;
const http = require('http');
const net = require('net');

// Ranges that must never be reachable from the scraper. Checked against every
// resolved address (and every browser request), not just the first URL.
const blockList = new net.BlockList();
[
  ['0.0.0.0', 8], // "this" network
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata (169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4] // reserved + broadcast
].forEach(([addr, prefix]) => blockList.addSubnet(addr, prefix, 'ipv4'));

[
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['64:ff9b::', 96], // NAT64 (can embed private IPv4)
  ['100::', 64], // discard-only
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // deprecated site-local
  ['ff00::', 8] // multicast
].forEach(([addr, prefix]) => blockList.addSubnet(addr, prefix, 'ipv6'));

// Returns the embedded IPv4 address for IPv4-mapped IPv6 (::ffff:a.b.c.d or
// ::ffff:aabb:ccdd), otherwise null.
function extractMappedIPv4(ip) {
  const normalized = String(ip || '').toLowerCase();
  const dotted = normalized.match(/^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (dotted) return dotted[1];

  const hex = normalized.match(/^(?:0{0,4}:){0,5}:?ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
  }
  return null;
}

function isPrivateIPv4(ip) {
  if (net.isIPv4(ip) === false) return true; // fail closed on malformed input
  return blockList.check(ip, 'ipv4');
}

function isPrivateIPv6(ip) {
  const value = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!net.isIPv6(value)) return true; // fail closed
  const mapped = extractMappedIPv4(value);
  if (mapped) return isPrivateIPv4(mapped);
  return blockList.check(value, 'ipv6');
}

function isBlockedIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) return isPrivateIPv4(ip);
  if (family === 6) return isPrivateIPv6(ip);
  return true;
}

const BLOCKED_HOSTNAMES = new Set(['localhost', '0.0.0.0']);

// Validates a hostname (or IP literal) by checking every address it resolves to.
async function validateHostname(rawHostname, lookup = dns.lookup) {
  const hostname = String(rawHostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!hostname) return { ok: false, reason: 'Missing hostname' };

  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    return { ok: false, reason: 'Local/internal hostnames are not allowed' };
  }

  if (net.isIP(hostname)) {
    return isBlockedIp(hostname)
      ? { ok: false, reason: 'Resolved IP is private or loopback and is blocked' }
      : { ok: true, addresses: [hostname] };
  }

  let records;
  try {
    records = await lookup(hostname, { all: true });
  } catch {
    return { ok: false, reason: 'Hostname resolution failed' };
  }
  if (!records || !records.length) {
    return { ok: false, reason: 'Hostname resolution failed' };
  }
  if (records.some((rec) => isBlockedIp(rec.address))) {
    return { ok: false, reason: 'Resolved IP is private or loopback and is blocked' };
  }
  return { ok: true, addresses: records.map((r) => r.address) };
}

async function validateScrapeUrl(rawUrl, options = {}) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'Invalid URL format' };
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, reason: 'Only http and https URLs are allowed' };
  }

  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'URLs with embedded credentials are not allowed' };
  }

  const hostCheck = await validateHostname(parsed.hostname, options.lookup);
  if (!hostCheck.ok) return hostCheck;

  return { ok: true, parsedUrl: parsed.toString() };
}

// Egress-filtering forward proxy for the scraper's browser.
//
// Playwright's request interception is not re-run for redirects that the browser
// follows internally, so route-based checks miss "public page -> 302 -> internal
// host". Routing all browser traffic through this proxy closes that gap: every
// hop (initial request, redirect, iframe, subresource) becomes a fresh CONNECT or
// absolute-form request. Each hostname is resolved here, all addresses are
// vetted, and the connection is made to the vetted IP itself, which also removes
// the DNS-rebinding window between "check" and "use".
function parseHostPort(target, defaultPort) {
  const m = String(target).match(/^\[([^\]]+)\](?::(\d+))?$/) || String(target).match(/^([^:]+)(?::(\d+))?$/);
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : defaultPort;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: m[1], port };
}

const HOP_BY_HOP = ['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'te', 'trailer', 'upgrade'];

function createGuardProxy({ lookup, dial, idleTimeoutMs = 30000 } = {}) {
  const connect = dial || ((address, port) => net.connect({ host: address, port }));
  const server = http.createServer();

  async function resolveTarget(host) {
    const verdict = await validateHostname(host, lookup);
    return verdict.ok ? verdict.addresses[0] : null;
  }

  // HTTPS (and any tunnelled) traffic.
  server.on('connect', async (req, clientSocket, head) => {
    clientSocket.on('error', () => {});
    const target = parseHostPort(req.url, 443);
    const address = target && (await resolveTarget(target.host));
    if (!address) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = connect(address, target.port);
    upstream.setTimeout(idleTimeoutMs, () => upstream.destroy());
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('close', () => upstream.destroy());
    upstream.on('connect', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
  });

  // Plain-HTTP traffic arrives in absolute form: GET http://host/path.
  server.on('request', async (clientReq, clientRes) => {
    let url;
    try {
      url = new URL(clientReq.url);
    } catch {
      clientReq.socket.destroy();
      return;
    }
    const target = url.protocol === 'http:' ? parseHostPort(url.host, 80) : null;
    const address = target && (await resolveTarget(target.host));
    if (!address) {
      // Drop the connection so the browser reports a network error rather than
      // rendering an error page as if it were the scraped content.
      clientReq.socket.destroy();
      return;
    }

    const headers = { ...clientReq.headers };
    HOP_BY_HOP.forEach((h) => delete headers[h]);
    const upstreamReq = http.request({
      method: clientReq.method,
      path: url.pathname + url.search,
      headers,
      createConnection: () => connect(address, target.port),
      timeout: idleTimeoutMs
    }, (upstreamRes) => {
      clientRes.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      upstreamRes.pipe(clientRes);
    });
    upstreamReq.on('timeout', () => upstreamReq.destroy());
    upstreamReq.on('error', () => clientReq.socket.destroy());
    clientReq.pipe(upstreamReq);
  });

  return {
    async listen() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return server.address().port;
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      });
    }
  };
}

module.exports = {
  isPrivateIPv4,
  isPrivateIPv6,
  isBlockedIp,
  extractMappedIPv4,
  validateHostname,
  validateScrapeUrl,
  createGuardProxy
};

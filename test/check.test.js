'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { scanLinks } = require('../lib/html');
const { analyseLinks, checkTargets, summarise, sameTarget } = require('../lib/check');
const { createServer } = require('../samples/mock-store');

function listen() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

const msgs = (findings) => findings.map((f) => f.severity + ' ' + f.message);

test('scanLinks reads text, image alt, aria-label and ignores script and noscript', () => {
  const { links } = scanLinks(
    '<script>"<a href=\'/x\'>x</a>"</script><noscript><a href="/n">n</a></noscript>' +
      '<a href="/a">Plain &amp; simple</a><a href="/b"><img src="i.png" alt="Logo"></a>' +
      '<a href="/c" aria-label="Cart"><svg></svg></a><a href="/d"><img src="i.png" alt=""></a><a name="x">no href</a>'
  );
  assert.deepStrictEqual(links.map((l) => l.href), ['/a', '/b', '/c', '/d']);
  assert.strictEqual(links[0].text, 'Plain & simple');
  assert.strictEqual(links[1].named, true);
  assert.strictEqual(links[2].named, true);
  assert.strictEqual(links[3].named, false);
});

test('scanLinks reports line numbers, <base> and region', () => {
  const { base, links } = scanLinks('<base href="/shop/">\n\n<footer>\n<a href="x">X</a></footer>');
  assert.strictEqual(base, '/shop/');
  assert.strictEqual(links[0].line, 4);
  assert.strictEqual(links[0].region, 'footer');
});

test('an unclosed <a> does not swallow the next link', () => {
  const { links } = scanLinks('<a href="/one">One<a href="/two">Two</a>');
  assert.deepStrictEqual(links.map((l) => l.text), ['One', 'Two']);
});

test('analyseLinks classifies internal, external and non-web links', () => {
  const page = analyseLinks(
    '<a href="/a">A</a><a href="https://www.shop.test/b">B</a><a href="https://other.test/c">C</a>' +
      '<a href="mailto:x@y.z">M</a><a href="tel:1">T</a><a href="#top">Top</a><a href="/a#frag">A again</a>',
    { baseUrl: 'https://shop.test/', label: 'p' }
  );
  assert.strictEqual(page.stats.internal, 3);
  assert.strictEqual(page.stats.external, 1);
  assert.strictEqual(page.stats.nonWeb, 2);
  assert.strictEqual(page.stats.sameAnchors, 1);
  assert.strictEqual(page.targets.size, 3); // /a and /a#frag are one target
  assert.strictEqual(page.targets.get('https://shop.test/a').count, 2);
});

test('static findings: unnamed, http, myshopify, placeholder, generic, collection path', () => {
  const page = analyseLinks(
    '<a href="/x"></a><a href="http://shop.test/y">Y</a><a href="https://s.myshopify.com/z">Z</a>' +
      '<a href="#">Toggle</a><a href="/q">Click here</a><a href="/collections/c/products/p">P</a>',
    { baseUrl: 'https://shop.test/', label: 'p' }
  );
  const m = msgs(page.findings).join('\n');
  assert.match(m, /error .*1 link has no accessible name/);
  assert.match(m, /warn .*1 link to your own store uses http:\/\//);
  assert.match(m, /warn .*\.myshopify\.com/);
  assert.match(m, /info .*1 link is a placeholder/);
  assert.match(m, /info .*generic text/);
  assert.match(m, /info .*\/collections\/\.\.\.\/products\//);
});

test('the myshopify and http rules stay quiet when you are on that host or on http', () => {
  const onMyshopify = analyseLinks('<a href="https://s.myshopify.com/z">Z</a>', { baseUrl: 'https://s.myshopify.com/', label: 'p' });
  assert.strictEqual(onMyshopify.findings.length, 0);
  const onHttp = analyseLinks('<a href="http://127.0.0.1/y">Y</a>', { baseUrl: 'http://127.0.0.1/', label: 'p' });
  assert.strictEqual(onHttp.findings.length, 0);
});

test('<base href> changes how relative links resolve', () => {
  const page = analyseLinks('<base href="/shop/"><a href="item">Item</a>', { baseUrl: 'https://shop.test/', label: 'p' });
  assert.ok(page.targets.has('https://shop.test/shop/item'));
});

test('without a base URL, relative links are not resolved or counted as errors', () => {
  const page = analyseLinks('<a href="/a">A</a><a href="https://x.test/b">B</a>', { label: 'p' });
  assert.strictEqual(page.stats.unresolved, 1);
  assert.strictEqual(page.targets.size, 1);
  assert.strictEqual(page.targets.get('https://x.test/b').internal, false);
});

test('sameTarget ignores trailing slashes and www, not paths or queries', () => {
  assert.ok(sameTarget('https://shop.test/a/', 'https://www.shop.test/a'));
  assert.ok(!sameTarget('https://shop.test/a', 'https://shop.test/b'));
  assert.ok(!sameTarget('https://shop.test/a?x=1', 'https://shop.test/a'));
});

test('live check against the mock store reports each planted problem once', async () => {
  const server = await listen();
  const base = 'http://127.0.0.1:' + server.address().port + '/';
  try {
    const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'samples', 'home-broken.html'), 'utf8');
    const page = analyseLinks(html, { baseUrl: base, label: 'home' });
    const res = await checkTargets(page, { timeout: 3000 });
    const m = msgs(res.findings);
    const has = (re) => m.some((x) => re.test(x));
    assert.ok(has(/error .*\/products\/gone-forever is broken: answers 404.*linked 2 times/));
    assert.ok(has(/error .*\/loop1 sits in a redirect loop/));
    assert.ok(has(/error .*\/boom answers a server error \(500\)/));
    assert.ok(has(/error .*\/pages\/members ends at the storefront password page/));
    assert.ok(has(/warn .*\/old-sale redirects \(301\) to .*\/collections\/sale/));
    assert.ok(has(/warn .*\/a goes through a redirect chain of 3 hops \(301 > 302 > 301 > 200\)/));
    // fine pages and the HEAD-405 page are not reported
    assert.ok(!has(/head-hater/));
    assert.ok(!has(/\/pages\/about/));
    assert.ok(!has(/\/collections\/sale\/products\/trail-backpack is broken/));
    // the <noscript> link is ignored, the external myshopify link is not requested
    assert.ok(!has(/noscript-link/));
    assert.ok(!has(/example-store.*could not be fetched/));
    assert.strictEqual(summarise(res.findings).errors, 4);
  } finally {
    server.close();
  }
});

test('--external is needed to request other hosts', async () => {
  const server = await listen();
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port + '/';
  try {
    const page = analyseLinks('<a href="http://localhost:' + port + '/products/gone">Ext</a>', { baseUrl: base, label: 'p' });
    assert.strictEqual([...page.targets.values()][0].internal, false);
    const skipped = await checkTargets(page, { timeout: 3000 });
    assert.strictEqual(skipped.checked, 0);
    const checked = await checkTargets(page, { timeout: 3000, external: true });
    assert.strictEqual(checked.checked, 1);
    assert.match(checked.findings[0].message, /is broken: answers 404/);
  } finally {
    server.close();
  }
});

test('a refused connection on an internal link is an error with a plain-language reason', async () => {
  const server = await listen();
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  const page = analyseLinks('<a href="/x">X</a>', { baseUrl: 'http://127.0.0.1:' + port + '/', label: 'p' });
  const res = await checkTargets(page, { timeout: 3000 });
  assert.strictEqual(res.findings[0].severity, 'error');
  assert.match(res.findings[0].message, /could not be fetched: the connection was refused/);
});

test('maxLinks limits requests and reports how many were left out', async () => {
  const server = await listen();
  const base = 'http://127.0.0.1:' + server.address().port + '/';
  try {
    const page = analyseLinks('<a href="/a1">1</a><a href="/a2">2</a><a href="/a3">3</a>', { baseUrl: base, label: 'p' });
    const res = await checkTargets(page, { maxLinks: 2, timeout: 3000 });
    assert.strictEqual(res.checked, 2);
    assert.strictEqual(res.skipped, 1);
  } finally {
    server.close();
  }
});

test('the cache is shared so a URL on two pages is requested once', async () => {
  let hits = 0;
  const fakeFetch = async () => {
    hits++;
    return { status: 200, headers: { get: () => null }, body: null };
  };
  const cache = new Map();
  const one = analyseLinks('<a href="/same">S</a>', { baseUrl: 'https://shop.test/', label: 'one' });
  const two = analyseLinks('<a href="/same">S</a>', { baseUrl: 'https://shop.test/', label: 'two' });
  await checkTargets(one, { cache, fetch: fakeFetch });
  await checkTargets(two, { cache, fetch: fakeFetch });
  assert.strictEqual(hits, 1);
});

test('401, 403 and 429 are "could not be verified", never errors', async () => {
  for (const status of [401, 403, 429]) {
    const fakeFetch = async () => ({ status, headers: { get: () => null }, body: null });
    const page = analyseLinks('<a href="/x">X</a>', { baseUrl: 'https://shop.test/', label: 'p' });
    const res = await checkTargets(page, { fetch: fakeFetch });
    assert.strictEqual(res.findings.length, 1);
    assert.strictEqual(res.findings[0].severity, 'info');
    assert.match(res.findings[0].message, /could not be verified/);
  }
});

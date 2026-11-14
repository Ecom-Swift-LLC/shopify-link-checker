'use strict';

const { scanLinks } = require('./html');

const GENERIC_TEXT = new Set(['click here', 'here', 'read more', 'more', 'learn more', 'click', 'link', 'this link', 'this page', 'continue']);
const NON_WEB = /^(mailto|tel|sms|javascript|data|blob|whatsapp|fb-messenger):/i;

function hostKey(u) {
  return u.host.toLowerCase().replace(/^www\./, '');
}

function shorten(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 3) + '...' : s;
}

function plural(n, one, many) {
  return n + ' ' + (n === 1 ? one : many);
}

/**
 * Looks at the links in one page without making any request.
 * Returns { label, stats, findings, targets } where targets is a Map of
 * URL (fragment removed) -> { url, internal, line, count, text }.
 */
function analyseLinks(html, options = {}) {
  const label = options.label || 'page';
  const { base: baseHref, links } = scanLinks(html);
  let baseUrl = null;
  let pageHost = null;
  if (options.baseUrl) {
    try {
      const page = new URL(options.baseUrl);
      pageHost = hostKey(page);
      baseUrl = baseHref ? new URL(baseHref, page) : page;
    } catch (e) {
      baseUrl = null;
      pageHost = null;
    }
  }
  const stats = { links: links.length, internal: 0, external: 0, sameAnchors: 0, nonWeb: 0, unresolved: 0 };
  const targets = new Map();
  const buckets = {
    unnamed: [],
    placeholder: [],
    generic: [],
    http: [],
    myshopify: [],
    collectionProduct: [],
  };

  for (const link of links) {
    const href = link.href;
    if (!link.named) buckets.unnamed.push(link);
    if (GENERIC_TEXT.has(link.text.toLowerCase().replace(/[.!»›>→]+$/g, '').trim())) buckets.generic.push(link);

    if (href === '' || href === '#' || /^javascript:/i.test(href)) {
      buckets.placeholder.push(link);
      continue;
    }
    if (href.startsWith('#')) {
      stats.sameAnchors++;
      continue;
    }
    if (NON_WEB.test(href)) {
      stats.nonWeb++;
      continue;
    }
    let url;
    try {
      url = baseUrl ? new URL(href, baseUrl) : new URL(href);
    } catch (e) {
      stats.unresolved++;
      continue;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      stats.nonWeb++;
      continue;
    }
    const internal = pageHost !== null && hostKey(url) === pageHost;
    if (internal) stats.internal++;
    else stats.external++;

    if (internal && baseUrl && baseUrl.protocol === 'https:' && url.protocol === 'http:') buckets.http.push(link);
    if (/\.myshopify\.com$/i.test(url.hostname) && !/\.myshopify\.com$/i.test(baseUrl ? baseUrl.hostname : '')) buckets.myshopify.push(link);
    if (internal && /^\/collections\/[^/]+\/products\/[^/]+/.test(url.pathname)) buckets.collectionProduct.push(link);

    url.hash = '';
    const key = url.href;
    const t = targets.get(key);
    if (t) t.count++;
    else targets.set(key, { url: key, internal, line: link.line, count: 1, text: link.text });
  }

  const findings = [];
  function add(severity, list, message) {
    if (!list.length) return;
    findings.push({ severity, message: label + ': ' + message, line: list[0].line });
  }
  const first = (list) => !list.length ? '' : ' (line '+ list[0].line + ': ' + shorten(list[0].href || '(empty)', 60) + ')';

  add('error', buckets.unnamed, plural(buckets.unnamed.length, 'link has', 'links have') + ' no accessible name: no text, no alt text on an image inside it and no aria-label. Screen readers announce only "link".' + first(buckets.unnamed));
  add('warn', buckets.http, plural(buckets.http.length, 'link to your own store uses', 'links to your own store use') + ' http:// on an https page. Each one costs a redirect and some browsers flag it.' + first(buckets.http));
  add('warn', buckets.myshopify, plural(buckets.myshopify.length, 'link points', 'links point') + ' at a .myshopify.com address instead of your primary domain. It works, but it splits traffic and signals across two hosts.' + first(buckets.myshopify));
  add('info', buckets.collectionProduct, plural(buckets.collectionProduct.length, 'link reaches', 'links reach') + ' a product through a /collections/.../products/ path. It loads, but the canonical page is /products/handle; link there directly where you can.' + first(buckets.collectionProduct));
  add('info', buckets.placeholder, plural(buckets.placeholder.length, 'link is a placeholder', 'links are placeholders') + ' (href="#", empty, or javascript:). If it triggers an action rather than navigating, a <button> is the correct element.' + first(buckets.placeholder));
  add('info', buckets.generic, plural(buckets.generic.length, 'link uses', 'links use') + ' generic text such as "click here" or "read more". Out of context, screen reader users and search engines learn nothing from it.' + first(buckets.generic));

  return { label, stats, findings, targets };
}

function pathOf(u) {
  const p = new URL(u);
  return p.pathname.replace(/\/+$/, '') || '/';
}

function sameTarget(a, b) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return hostKey(x) === hostKey(y) && pathOf(a) === pathOf(b) && x.search === y.search;
  } catch (e) {
    return a === b;
  }
}

async function request(url, method, o) {
  const res = await o.fetch(url, {
    method,
    redirect: 'manual',
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; shopify-link-checker)', accept: '*/*' },
    signal: AbortSignal.timeout(o.timeout),
  });
  if (res.body && res.body.cancel) await res.body.cancel().catch(() => {});
  return { status: res.status, location: res.headers.get('location') };
}

/** Follows redirects one hop at a time so the whole chain is visible. */
async function probe(startUrl, o) {
  const chain = [];
  const seen = new Set();
  let cur = startUrl;
  for (let hop = 0; hop <= o.maxRedirects; hop++) {
    if (seen.has(cur)) return { chain, loop: true };
    seen.add(cur);
    let res = await request(cur, 'HEAD', o);
    if (res.status >= 400) res = await request(cur, 'GET', o); // some servers answer HEAD wrongly
    chain.push({ url: cur, status: res.status });
    if (res.status >= 300 && res.status < 400 && res.location) {
      cur = new URL(res.location, cur).href;
      continue;
    }
    return { chain, status: res.status, finalUrl: cur };
  }
  return { chain, tooMany: true };
}

async function mapLimit(items, limit, delay, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

function describeError(e) {
  if (e && e.name === 'TimeoutError') return 'the request timed out';
  const code = e && e.cause && e.cause.code;
  if (code === 'ENOTFOUND') return 'the host name does not exist (DNS lookup failed)';
  if (code === 'ECONNREFUSED') return 'the connection was refused';
  return (e && e.cause && e.cause.message) || (e && e.message) || 'request failed';
}

/**
 * Requests the link targets and turns the answers into findings.
 * options: external (also check other hosts), maxLinks, concurrency, delay (ms),
 * timeout (ms), maxRedirects, cache (Map shared between pages), fetch (for tests).
 */
async function checkTargets(page, options = {}) {
  const o = {
    external: Boolean(options.external),
    maxLinks: options.maxLinks || 300,
    concurrency: options.concurrency || 4,
    delay: options.delay || 0,
    timeout: options.timeout || 10000,
    maxRedirects: options.maxRedirects || 10,
    cache: options.cache || new Map(),
    fetch: options.fetch || fetch,
  };
  const all = [...page.targets.values()].filter((t) => t.internal || o.external);
  const picked = all.slice(0, o.maxLinks);
  const skipped = all.length - picked.length;
  const findings = [];

  const results = await mapLimit(picked, o.concurrency, o.delay, async (t) => {
    if (!o.cache.has(t.url)) {
      o.cache.set(t.url, probe(t.url, o).catch((e) => ({ chain: [], error: describeError(e) })));
    }
    return { t, r: await o.cache.get(t.url) };
  });

  for (const { t, r } of results) {
    const where = ' (line ' + t.line + (t.count > 1 ? ', linked ' + t.count + ' times' : '') + (t.text ? ', text "' + shorten(t.text, 40) + '"' : '') + ')';
    const name = page.label + ': ' + shorten(t.url, 90);
    const push = (severity, msg) => findings.push({ severity, message: name + ' ' + msg + where, line: t.line, url: t.url });

    if (r.error) {
      push(t.internal ? 'error' : 'warn', 'could not be fetched: ' + r.error + '.');
      continue;
    }
    if (r.loop) {
      push('error', 'sits in a redirect loop (' + r.chain.map((c) => c.status).join(' > ') + ' and back to the start).');
      continue;
    }
    if (r.tooMany) {
      push('error', 'redirects more than ' + o.maxRedirects + ' times without arriving anywhere.');
      continue;
    }
    const hops = r.chain.length - 1;
    const finalPath = pathOf(r.finalUrl);
    if (r.status === 404 || r.status === 410) {
      push('error', 'is broken: ' + (hops ? 'redirects ' + plural(hops, 'time', 'times') + ' and then ' : 'answers ') + r.status + '.' + (hops ? ' Final URL: ' + shorten(r.finalUrl, 70) : ''));
    } else if (r.status >= 500) {
      push(t.internal ? 'error' : 'warn', 'answers a server error (' + r.status + '). Re-run it before you rely on this; it may be temporary.');
    } else if ([401, 403, 429, 999].includes(r.status)) {
      push('info', 'could not be verified: the server answered ' + r.status + ' to an automated request. Open it in a browser.');
    } else if (r.status >= 400) {
      push('warn', 'answers ' + r.status + '.');
    } else if (t.internal && finalPath === '/password') {
      push('error', 'ends at the storefront password page. Visitors without the password cannot reach it.');
    } else if (t.internal && finalPath === '/404') {
      push('error', 'redirects to /404.');
    } else if (hops >= 2 && (t.internal || hops >= 3)) {
      push('warn', 'goes through a redirect chain of ' + hops + ' hops (' + r.chain.map((c) => c.status).join(' > ') + ') before reaching ' + shorten(r.finalUrl, 70) + '. Link straight to the final URL.');
    } else if (hops === 1 && t.internal && !sameTarget(t.url, r.finalUrl)) {
      push('warn', 'redirects (' + r.chain[0].status + ') to ' + shorten(r.finalUrl, 70) + '. Update the link so visitors and crawlers skip the extra request.');
    }
  }
  return {
    findings,
    checked: picked.length,
    skipped,
    results: results.map(({ t, r }) => ({
      url: t.url,
      internal: t.internal,
      status: r.status || null,
      hops: r.chain ? Math.max(0, r.chain.length - 1) : 0,
      finalUrl: r.finalUrl || null,
      error: r.error || null,
    })),
  };
}

function summarise(findings) {
  const t = { errors: 0, warnings: 0, info: 0 };
  for (const f of findings) {
    if (f.severity === 'error') t.errors++;
    else if (f.severity === 'warn') t.warnings++;
    else t.info++;
  }
  return t;
}

function sortFindings(findings) {
  const rank = { error: 0, warn: 1, info: 2 };
  return findings
    .map((f, i) => [f, i])
    .sort((a, b) => rank[a[0].severity] - rank[b[0].severity] || a[1] - b[1])
    .map((x) => x[0]);
}

module.exports = { analyseLinks, checkTargets, summarise, sortFindings, sameTarget };

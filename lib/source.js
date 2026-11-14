'use strict';

const fs = require('fs');

function normaliseUrl(input) {
  let u = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'https://' + u;
  return new URL(u).href;
}

async function readSource(input, options = {}) {
  if (input === '-') {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    return { label: 'stdin', baseUrl: options.base ? normaliseUrl(options.base) : null, html: Buffer.concat(chunks).toString('utf8') };
  }
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input) && fs.existsSync(input)) {
    return { label: input, baseUrl: options.base ? normaliseUrl(options.base) : null, html: fs.readFileSync(input, 'utf8') };
  }
  const url = normaliseUrl(input);
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; shopify-link-checker)', accept: 'text/html,*/*;q=0.8' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(url + ' answered HTTP ' + res.status);
  const type = res.headers.get('content-type') || '';
  if (type && !/html/i.test(type)) throw new Error(url + ' returned ' + type + ', not HTML');
  const html = await res.text();
  const parsed = new URL(res.url);
  let path = parsed.pathname + parsed.search;
  if (path.length > 40) path = path.slice(0, 37) + '...';
  return { label: path === '/' ? parsed.host + '/' : path, baseUrl: res.url, html };
}

module.exports = { readSource, normaliseUrl };

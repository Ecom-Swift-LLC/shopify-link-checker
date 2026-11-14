'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn } = require('child_process');
const { createServer } = require('../samples/mock-store');

const BIN = path.join(__dirname, '..', 'bin', 'slc.js');
const SAMPLES = path.join(__dirname, '..', 'samples');

function run(args, stdin) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [BIN, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
    p.stdin.end(stdin || '');
  });
}

function listen() {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}

test('static check of the broken sample exits 1 and prints line numbers', async () => {
  const r = await run(['check', path.join(SAMPLES, 'home-broken.html'), '--base', 'https://shop.example.com', '--no-fetch']);
  assert.strictEqual(r.code, 1);
  assert.match(r.out, /\[ERROR\]/);
  assert.match(r.out, /line \d+/);
});

test('a local file with no --base says so instead of failing', async () => {
  const r = await run(['check', path.join(SAMPLES, 'home-clean.html')]);
  assert.strictEqual(r.code, 0);
  assert.match(r.out, /no base URL/);
});

test('live check: broken page exits 1, clean page exits 0', async () => {
  const server = await listen();
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    const bad = await run(['check', base + '/']);
    assert.strictEqual(bad.code, 1);
    assert.match(bad.out, /is broken: answers 404/);
    assert.match(bad.out, /redirect chain of 3 hops/);
    const ok = await run(['check', path.join(SAMPLES, 'home-clean.html'), '--base', base]);
    assert.strictEqual(ok.code, 0);
    assert.match(ok.out, /No findings/);
  } finally {
    server.close();
  }
});

test('--strict fails on warnings only', async () => {
  const html = '<a href="https://s.myshopify.com/p">Shop</a>';
  assert.strictEqual((await run(['check', '-', '--base', 'https://shop.test', '--no-fetch'], html)).code, 0);
  assert.strictEqual((await run(['check', '-', '--base', 'https://shop.test', '--no-fetch', '--strict'], html)).code, 1);
});

test('--json is parseable and carries totals', async () => {
  const r = await run(['check', path.join(SAMPLES, 'home-broken.html'), '--base', 'https://shop.example.com', '--no-fetch', '--json']);
  const data = JSON.parse(r.out);
  assert.ok(data.errors > 0);
  assert.ok(Array.isArray(data.pages[0].findings));
  assert.strictEqual(data.pages[0].requested, 0);
});

test('usage errors exit 2', async () => {
  assert.strictEqual((await run(['check'])).code, 2);
  assert.strictEqual((await run(['bogus'])).code, 2);
  assert.strictEqual((await run(['check', '-', '--max-links', 'x'])).code, 2);
  assert.strictEqual((await run(['check', '-', '--timeout'])).code, 2);
  assert.strictEqual((await run(['check', '-', '--nope'])).code, 2);
  assert.strictEqual((await run([])).code, 2);
  assert.strictEqual((await run(['--help'])).code, 0);
});

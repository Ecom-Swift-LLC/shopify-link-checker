#!/usr/bin/env node
'use strict';

// A tiny local "store" with deliberate link problems, so you can try the checker
// without touching a real shop:
//   node samples/mock-store.js          (listens on 127.0.0.1:8787)
//   node bin/slc.js check http://127.0.0.1:8787/

const http = require('http');
const fs = require('fs');
const path = require('path');

function createServer() {
  const page = fs.readFileSync(path.join(__dirname, 'home-broken.html'), 'utf8');
  return http.createServer((req, res) => {
    const u = req.url.split('?')[0];
    const redirect = (code, to) => {
      res.writeHead(code, { location: to });
      res.end();
    };
    const ok = (body) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(req.method === 'HEAD' ? '' : body || '<p>ok</p>');
    };
    if (u === '/') return ok(page);
    if (['/products/trail-backpack', '/collections/sale/products/trail-backpack', '/collections/sale', '/pages/about', '/final', '/cart', '/password'].includes(u)) return ok();
    if (u === '/old-sale') return redirect(301, '/collections/sale');
    if (u === '/a') return redirect(301, '/b');
    if (u === '/b') return redirect(302, '/c');
    if (u === '/c') return redirect(301, '/final');
    if (u === '/loop1') return redirect(302, '/loop2');
    if (u === '/loop2') return redirect(302, '/loop1');
    if (u === '/pages/members') return redirect(302, '/password');
    if (u === '/boom') {
      res.writeHead(500);
      return res.end();
    }
    if (u === '/products/head-hater') {
      // answers HEAD with 405 but GET with 200: must not be reported as broken
      if (req.method === 'HEAD') {
        res.writeHead(405);
        return res.end();
      }
      return ok();
    }
    res.writeHead(404, { 'content-type': 'text/html' });
    res.end('<p>not found</p>');
  });
}

module.exports = { createServer };

if (require.main === module) {
  const port = Number(process.env.PORT) || 8787;
  createServer().listen(port, '127.0.0.1', () => console.log('mock store on http://127.0.0.1:' + port + '/'));
}

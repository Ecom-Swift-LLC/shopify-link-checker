#!/usr/bin/env node
'use strict';

const { analyseLinks, checkTargets, summarise, sortFindings } = require('../lib/check');
const { readSource } = require('../lib/source');

const HELP = `slc - Shopify link checker

Usage:
  slc check <page> [<page> ...]   check the links on one or more pages
                                  a page is a store URL or domain, a saved .html file, or - for stdin

Options:
  --external         also request links to other websites (default: your own domain only)
  --no-fetch         read the page only; make no request for the links it contains
  --max-links <n>    most link targets to request per page (default 300)
  --concurrency <n>  requests in flight at once (default 4)
  --delay <ms>       pause after each request in a worker (default 0)
  --timeout <ms>     per-request timeout (default 10000)
  --base <url>       base URL for relative links when reading a local file or stdin
  --json             machine-readable output
  --strict           exit 1 on warnings as well as errors
  -h, --help         show this help

Exit codes: 0 clean, 1 errors (or warnings with --strict), 2 the tool could not run.
`;

function whole(name, v, min) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new Error(name + ' needs a whole number of ' + min + ' or more');
  return n;
}

function parseArgs(argv) {
  const args = { _: [], json: false, strict: false, external: false, fetch: true, maxLinks: 300, concurrency: 4, delay: 0, timeout: 10000, base: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(a + ' needs a value');
      return argv[++i];
    };
    if (a === '--json') args.json = true;
    else if (a === '--strict') args.strict = true;
    else if (a === '--external') args.external = true;
    else if (a === '--no-fetch') args.fetch = false;
    else if (a === '--max-links') args.maxLinks = whole(a, val(), 1);
    else if (a === '--concurrency') args.concurrency = whole(a, val(), 1);
    else if (a === '--delay') args.delay = whole(a, val(), 0);
    else if (a === '--timeout') args.timeout = whole(a, val(), 1);
    else if (a === '--base') args.base = val();
    else if (a === '-h' || a === '--help') args.help = true;
    else if (a.startsWith('--')) throw new Error('unknown option "' + a + '"');
    else args._.push(a);
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.help || args._[0] !== 'check') {
    if (!args.help && args._[0]) throw new Error('unknown command "' + args._[0] + '"');
    console.log(HELP);
    return args.help ? 0 : 2;
  }
  const inputs = args._.slice(1);
  if (!inputs.length) throw new Error('check needs a store URL, a .html file, or - for stdin');

  const cache = new Map();
  const pages = [];
  const notes = [];
  for (const input of inputs) {
    const src = await readSource(input, { base: args.base });
    const page = analyseLinks(src.html, { label: src.label, baseUrl: src.baseUrl });
    page.checked = 0;
    page.skipped = 0;
    if (args.fetch && src.baseUrl) {
      const res = await checkTargets(page, {
        external: args.external,
        maxLinks: args.maxLinks,
        concurrency: args.concurrency,
        delay: args.delay,
        timeout: args.timeout,
        cache,
      });
      page.findings.push(...res.findings);
      page.checked = res.checked;
      page.skipped = res.skipped;
    } else if (args.fetch) {
      notes.push(src.label + ': no base URL, so relative links cannot be requested. Pass --base https://your-store.com, or use --no-fetch to skip this step.');
    }
    page.findings = sortFindings(page.findings);
    pages.push(page);
  }
  const findings = pages.flatMap((p) => p.findings);
  const totals = summarise(findings);

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          pages: pages.map((p) => ({ label: p.label, stats: p.stats, requested: p.checked, notRequested: p.skipped, findings: p.findings })),
          notes,
          ...totals,
        },
        null,
        2
      )
    );
  } else {
    for (const p of pages) {
      const s = p.stats;
      console.log(
        p.label + ': ' + s.links + ' link(s), ' + s.internal + ' to your domain, ' + s.external + ' external, ' + s.sameAnchors + ' in-page anchor(s), ' + s.nonWeb + ' mailto/tel/other; requested ' + p.checked + ' URL(s)' +
          (p.skipped ? ', ' + p.skipped + ' not requested (over --max-links)' : '')
      );
    }
    for (const n of notes) console.log('Note: ' + n);
    console.log('\nLink check\n');
    if (!findings.length) console.log('No findings.');
    for (const f of findings) {
      const tag = f.severity === 'error' ? '[ERROR]' : f.severity === 'warn' ? '[WARN ]' : '[INFO ]';
      console.log(tag + ' ' + f.message);
    }
    console.log('\n' + totals.errors + ' error(s), ' + totals.warnings + ' warning(s), ' + totals.info + ' info');
  }
  if (totals.errors > 0) return 1;
  if (args.strict && totals.warnings > 0) return 1;
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error('slc: ' + err.message);
    process.exitCode = 2;
  }
);

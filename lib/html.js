'use strict';

// A small, forgiving HTML scanner. It is not a spec-compliant parser: it walks
// tags in document order, which is all the link checks need. Script, style,
// template and noscript bodies are skipped so fallback markup is not counted twice.

const SKIP = new Set(['script', 'style', 'template', 'noscript']);
const TAG_RE = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>|([^<]+)|</g;
const ATTR_RE = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function decode(s) {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function parseAttrs(raw) {
  const attrs = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(raw))) {
    const name = m[1].toLowerCase();
    if (name in attrs) continue; // first one wins, as in browsers
    const value = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
    attrs[name] = value === undefined ? '' : decode(value);
  }
  return attrs;
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

function lineAt(starts, index) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/**
 * Returns { base, links }. `base` is the href of <base>, if any.
 * Each link (an <a> with an href attribute) has: href, line, text (visible
 * text plus alt text of images inside it), named (does it have an accessible
 * name), region ('header'|'nav'|'footer'|'main'|'body').
 */
function scanLinks(html) {
  const links = [];
  const starts = lineStarts(html);
  const regions = [];
  const open = [];
  let base = null;
  let skipUntil = null;
  let m;

  function finish(a) {
    if (a.link) {
      const text = a.text.replace(/\s+/g, ' ').trim();
      a.link.text = text;
      a.link.named = Boolean(text || a.label);
      links.push(a.link);
    }
  }

  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(html))) {
    if (m[0].startsWith('<!--')) continue;
    if (m[4] !== undefined) {
      if (!skipUntil && open.length) open[open.length - 1].text += ' ' + decode(m[4]);
      continue;
    }
    if (m[2] === undefined) continue;
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    if (skipUntil) {
      if (closing && name === skipUntil) skipUntil = null;
      continue;
    }
    if (!closing && SKIP.has(name) && !/\/\s*$/.test(m[3])) {
      skipUntil = name;
      continue;
    }
    const attrs = closing ? {} : parseAttrs(m[3]);
    if (name === 'header' || name === 'nav' || name === 'footer' || name === 'main') {
      if (closing) {
        for (let i = regions.length - 1; i >= 0; i--) {
          if (regions[i] === name) {
            regions.splice(i, 1);
            break;
          }
        }
      } else regions.push(name);
    } else if (name === 'base' && !closing && attrs.href && base === null) {
      base = attrs.href;
    } else if (name === 'a') {
      if (closing) {
        const a = open.pop();
        if (a) finish(a);
      } else {
        // a new <a> closes an unclosed previous one, as browsers do
        while (open.length) finish(open.pop());
        const a = {
          text: '',
          label: Boolean((attrs['aria-label'] || attrs['aria-labelledby'] || '').trim()),
          link: null,
        };
        if (attrs.href !== undefined) {
          a.link = {
            href: attrs.href.trim(),
            line: lineAt(starts, m.index),
            region: regions.length ? regions[regions.length - 1] : 'body',
            text: '',
            named: false,
          };
        }
        open.push(a);
      }
    } else if (open.length && !closing) {
      const a = open[open.length - 1];
      if (name === 'img' && (attrs.alt || '').trim()) a.text += ' ' + attrs.alt;
      if (name === 'svg' && (attrs['aria-label'] || '').trim()) a.label = true;
    }
  }
  while (open.length) finish(open.pop());
  return { base, links };
}

module.exports = { scanLinks, parseAttrs };

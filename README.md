# shopify-link-checker

A zero-dependency CLI that reads a Shopify storefront page, takes every link on it and checks where each one really goes: links that return 404, links that sit in a redirect loop or a chain of three redirects, links that quietly bounce through a redirect you could skip, links that end at your storefront password page, and links with no accessible name for a screen reader.

**Not sure your store's SEO, speed and accessibility basics are covered?** [Run the free audit](https://audit.ecomswiftllc.com/?utm_source=github&utm_medium=repo&utm_campaign=shopify-link-checker) - it checks SEO, speed, CRO and AI-visibility signals on a live store in about a minute.

## Why this exists

A deleted product's URL returns a 404, and a renamed collection or product handle breaks every menu item, banner and blog link that pointed at it. Redirects from the old URL help visitors, but the link itself should still be fixed: each redirect costs a request, and chains of them waste crawl budget. Nobody notices until a customer, or Google Search Console, does.

This tool does the tedious part: list the links on a page, request each distinct URL once, and tell you which ones need a person to look at them.

## Example output

Two ways to see it without pointing it at a real store. First, the static checks (no requests are made) on [`samples/home-broken.html`](samples/home-broken.html), which plants these mistakes on purpose. The `<script>` and `<noscript>` copies of links in that file are correctly ignored:

```
$ slc check samples/home-broken.html --base https://shop.example.com --no-fetch

samples/home-broken.html: 21 link(s), 15 to your domain, 1 external, 1 in-page anchor(s), 2 mailto/tel/other; requested 0 URL(s)

Link check

[ERROR] samples/home-broken.html: 2 links have no accessible name: no text, no alt text on an image inside it and no aria-label. Screen readers announce only "link". (line 17: /cart)
[WARN ] samples/home-broken.html: 1 link points at a .myshopify.com address instead of your primary domain. It works, but it splits traffic and signals across two hosts. (line 25: https://example-store.myshopify.com/pages/about)
[INFO ] samples/home-broken.html: 1 link reaches a product through a /collections/.../products/ path. It loads, but the canonical page is /products/handle; link there directly where you can. (line 20: /collections/sale/products/trail-backpack)
[INFO ] samples/home-broken.html: 2 links are placeholders (href="#", empty, or javascript:). If it triggers an action rather than navigating, a <button> is the correct element. (line 23: #)
[INFO ] samples/home-broken.html: 1 link uses generic text such as "click here" or "read more". Out of context, screen reader users and search engines learn nothing from it. (line 23: /pages/about)

1 error(s), 1 warning(s), 3 info
```

Second, the live checks against [`samples/mock-store.js`](samples/mock-store.js), a tiny local server that serves the same page and answers the way a store with broken links would (`node samples/mock-store.js` in one terminal, `node bin/slc.js check http://127.0.0.1:8787/` in another):

```
127.0.0.1:8787/: 21 link(s), 15 to your domain, 1 external, 1 in-page anchor(s), 2 mailto/tel/other; requested 12 URL(s)

Link check

[ERROR] 127.0.0.1:8787/: 2 links have no accessible name: ... (line 17: /cart)
[ERROR] 127.0.0.1:8787/: http://127.0.0.1:8787/pages/members ends at the storefront password page. Visitors without the password cannot reach it. (line 15, text "Members area")
[ERROR] 127.0.0.1:8787/: http://127.0.0.1:8787/products/gone-forever is broken: answers 404. (line 21, linked 2 times, text "Winter jacket")
[ERROR] 127.0.0.1:8787/: http://127.0.0.1:8787/loop1 sits in a redirect loop (302 > 302 and back to the start). (line 22, text "Loop")
[ERROR] 127.0.0.1:8787/: http://127.0.0.1:8787/boom answers a server error (500). Re-run it before you rely on this; it may be temporary. (line 22, text "Boom")
[WARN ] 127.0.0.1:8787/: http://127.0.0.1:8787/old-sale redirects (301) to http://127.0.0.1:8787/collections/sale. Update the link so visitors and crawlers skip the extra request. (line 13, text "Clearance")
[WARN ] 127.0.0.1:8787/: http://127.0.0.1:8787/a goes through a redirect chain of 3 hops (301 > 302 > 301 > 200) before reaching http://127.0.0.1:8787/final. Link straight to the final URL. (line 21, text "Spring jacket")
[WARN ] 127.0.0.1:8787/: 1 link points at a .myshopify.com address ... (line 25: https://example-store.myshopify.com/pages/about)
[INFO ] 127.0.0.1:8787/: ... (the three info notes from the static run)

5 error(s), 3 warning(s), 3 info
```

(`...` replaces text repeated from the first listing in this README only; the tool prints it in full.) The mock store also has a page that answers `HEAD` with 405 but `GET` with 200; it is correctly not reported, because the tool retries a failed `HEAD` as a `GET` before calling a link broken. `samples/home-clean.html` exits `0` with no findings.

## Features

- **Broken links.** 404 and 410 answers, server errors (5xx) and connections that fail, each with the line number in the page, how many times the URL is linked and the anchor text, so you can find it.
- **Redirects, followed one hop at a time.** Loops, chains of two or more hops, and links whose target redirects once to somewhere else, which is the link to update. The chain is printed (`301 > 302 > 301 > 200`).
- **Password page and `/404` redirects.** A link that ends at the storefront password page, or at `/404`, is an error.
- **Store-specific link smells.** Links that use `http://` to your own `https` store, links to the `.myshopify.com` address instead of your primary domain, and products linked through `/collections/<handle>/products/<handle>` instead of the canonical `/products/<handle>`.
- **Accessibility.** Links with no accessible name (an icon-only link with no `aria-label`, an image with empty `alt`, an empty `<a>`), placeholder `href="#"` and `javascript:` links that should be buttons, and "click here" link text.
- **Polite by default.** Each distinct URL is requested once, with a small number in flight (`--concurrency 4`), a request cap per page (`--max-links 300`) and an optional pause (`--delay`). A `429`, `403` or `401` answer is reported as "could not be verified", never as a broken link.
- **Your domain only, unless you ask.** `--external` also requests links to other websites. External failures are warnings, not errors, because the problem is on someone else's server.
- **CI-friendly.** Exit `0` clean, `1` on errors (or warnings with `--strict`), `2` if the tool could not run. `--json` for machine-readable output. Several pages in one run share their results, so a URL linked from five pages is requested once.

## Installation

Needs Node 18 or newer. No `npm install` step: there are no dependencies.

```bash
git clone https://github.com/Ecom-Swift-LLC/shopify-link-checker.git
cd shopify-link-checker
node bin/slc.js --help
```

Optionally `npm link` to get an `slc` command on your path.

## Usage

```bash
# check one page (use the primary domain)
node bin/slc.js check your-store.com

# check the pages that carry the most links in one run
node bin/slc.js check your-store.com your-store.com/collections/all your-store.com/pages/contact

# also request links to other websites
node bin/slc.js check your-store.com --external

# a saved file or stdin (pass --base so relative links can be requested)
node bin/slc.js check ./home.html --base https://your-store.com/
curl -s https://your-store.com | node bin/slc.js check - --base https://your-store.com/

# read-only on the page itself: static checks, no requests for the links
node bin/slc.js check your-store.com --no-fetch

# CI: fail the build on warnings too, machine-readable output, gentle on the server
node bin/slc.js check your-store.com --strict --json --concurrency 2 --delay 200
```

The tool reads the HTML your server sends. Menus and links built by JavaScript after load are not in it; see the limits below.

## Fixing what it finds

| You see | What to do |
| --- | --- |
| `is broken: answers 404` | Edit the menu, banner, rich-text or blog post that holds the link. In the admin: **Online Store > Navigation** for menus. If the product is gone for good, link to its collection and add a redirect under **Online Store > Navigation > View URL redirects**. |
| `redirects (301) to ...` | Update the link to the final URL. The redirect keeps working for people who bookmarked the old one. |
| `redirect chain of N hops` | Link straight to the last URL, then collapse the chain in **URL redirects** so the old URL points at the final one. |
| `ends at the storefront password page` | The link points at something only reachable behind a password (a members page, a draft page). Remove the link or publish the page. |
| `no accessible name` | Add visible text, or `aria-label="Cart"` on the link, or a real `alt` on the image inside it. |
| `/collections/.../products/...` | Use `{{ product.url }}` or `{{ product.url \| within: collection }}` deliberately; for plain links, `{{ product.url }}` gives the canonical `/products/handle`. |

Redirects themselves are managed in the Shopify admin (or in bulk with [shopify-redirect-manager](https://github.com/Ecom-Swift-LLC/shopify-redirect-manager)); this tool only finds the links that need them.

## What it does NOT do

- **It reads HTML, not a rendered page.** Links added by JavaScript after load (some mega menus, apps, popups, review widgets) are invisible to it. A page behind a password gives you the password page's links.
- **It checks the links on the pages you give it, not the whole site.** It does not crawl. Run it on your home page, a collection, a product and a page that carries a long menu, or feed it a list of pages from your sitemap.
- **It cannot tell a soft 404 from a real page.** A page that answers `200` while saying "not found" is reported as fine. A theme that redirects every unknown URL to the home page hides broken links from it too.
- **It cannot verify what servers refuse to tell it.** Social networks and some marketplaces answer automated requests with `403`, `429` or `999`. Those are listed as "could not be verified"; open them in a browser.
- **It does not check that a link goes to the right place.** A link to the wrong product that returns `200` is not a problem it can see.
- **It does not check images, scripts or stylesheets**, only `<a href>` links. For images use [shopify-image-auditor](https://github.com/Ecom-Swift-LLC/shopify-image-auditor).
- **It does not edit anything.** No file in your theme or setting in your store is changed, and it makes no admin API calls.
- **It does not replace an accessibility audit.** "Has a name" is a minimum, not a judgement that the name is good.

## FAQ

**Is it safe to run on a live store?** It sends a `HEAD` request per distinct URL (a `GET` only when `HEAD` fails), four at a time by default. That is a few hundred light requests, far less than a crawler. Lower `--concurrency` and add `--delay` if you want it gentler.

**Why does a link to a deleted product count as an error when I have a redirect for it?** It does not: with a working redirect it shows as "redirects to ...", a warning telling you to update the link. A 404 means there is no redirect either.

**Why is `/collections/x/products/y` only an info note?** It works and Shopify's canonical tag points at `/products/y`, so it is not broken. It is worth tidying because it shows up as a separate URL in your analytics and link reports.

**What does "could not be verified" mean?** The server answered `401`, `403`, `429` or `999` to an automated request. That is usually bot protection, not a broken link.

## Run it against your own store

Dead links are one of several things that decide how well a store ranks and converts. If this turned up a lot, the [free store audit](https://audit.ecomswiftllc.com/?utm_source=github&utm_medium=repo&utm_campaign=shopify-link-checker) looks at the rest in the same pass: SEO, page speed, conversion and how AI shopping assistants read your catalogue.

## Related Shopify tools

Also from Ecom Swift LLC:

- [shopify-redirect-manager](https://github.com/Ecom-Swift-LLC/shopify-redirect-manager) creates and audits URL redirects in bulk, the other half of fixing broken links.
- [shopify-sitemap-auditor](https://github.com/Ecom-Swift-LLC/shopify-sitemap-auditor) and [shopify-robots-txt-auditor](https://github.com/Ecom-Swift-LLC/shopify-robots-txt-auditor) cover the crawl side of the same SEO work.
- [shopify-image-auditor](https://github.com/Ecom-Swift-LLC/shopify-image-auditor) does for images what this does for links.
- [shopify-structured-data-validator](https://github.com/Ecom-Swift-LLC/shopify-structured-data-validator) checks product-page JSON-LD.
- [shopify-accessible-components](https://github.com/Ecom-Swift-LLC/shopify-accessible-components) has WCAG-conscious Liquid components for navigation, modals and filters.
- [shopify-seo-checklist](https://github.com/EcomswiftLLC/shopify-seo-checklist) is the written SEO checklist for what a tool cannot see.

## Contributing

Issues and PRs welcome, especially a real page this tool got wrong (a false positive or a miss), with the HTML attached after removing anything private. Run the suite with `npm test` (plain `node --test`, no test framework dependency; the live tests run against a local HTTP server from `samples/mock-store.js`) and add a case for any new rule.

## Roadmap

- `--sitemap` to take a list of pages from a store's sitemap and check them all in one run
- Check `#fragment` links against the `id` attributes on the same page
- `--baseline` to snapshot findings and report only what is new since the last run
- A GitHub Action wrapper, matching the one in `shopify-theme-deploy-action`

## License

MIT, Ecom Swift LLC. See [LICENSE](LICENSE).

## Need help?

We build Shopify themes, storefronts and automation for a living. If a check here turned up something you would rather have fixed than DIY, or you want a second pair of eyes on your store generally:

- **Free store audit** (SEO + speed + CRO + AI visibility, one report): [audit.ecomswiftllc.com](https://audit.ecomswiftllc.com/?utm_source=github&utm_medium=repo&utm_campaign=shopify-link-checker)
- **More free tools**: [ecomswiftllc.com/free-tools](https://www.ecomswiftllc.com/free-tools)
- **Shopify Partner Directory**: [shopify.com/partners/directory/partner/waowy](https://www.shopify.com/partners/directory/partner/waowy)
- **Website**: [ecomswiftllc.com](https://www.ecomswiftllc.com)

---

Built because the same few link problems keep turning up on store audits: a menu item pointing at a product deleted a year ago, a banner that goes through three redirects, and a cart icon with no name for a screen reader. Free and complete, no catch.

/**
 * Fixture builder (D4 frozen-text). Fetches article HTML, runs the shipping
 * scripts/Readability.js over it via jsdom, and writes bench/fixtures/<slug>.json
 * mirroring orchestrator.js's pageData shape. Freezing the extracted text is the
 * D4 stability guarantee; live grounding (search) still drifts by design.
 *
 * Usage:
 *   node extract.js <url> [<url> ...]
 *   node extract.js                 # reads urls (one per line) from bench/urls.txt
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const Readability = require('../scripts/Readability.js');

const FIXTURES = path.join(__dirname, 'fixtures');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function slugFor(url) {
  const u = new URL(url);
  const base = (u.hostname.replace(/^www\./, '') + u.pathname)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return base.slice(0, 80) || 'article';
}

async function extract(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`fetch ${res.status} for ${url}`);
  const html = await res.text();

  const dom = new JSDOM(html, { url });
  const article = new Readability(dom.window.document).parse();
  if (!article || !article.textContent) throw new Error(`Readability found no article body: ${url}`);

  const bodyText = article.textContent.replace(/\s+/g, ' ').trim();
  const pageData = {
    title: article.title || dom.window.document.title || '',
    domain: new URL(url).hostname,
    author: article.byline || 'Unknown',
    siteName: article.siteName || '',
    excerptStart: bodyText,
    excerptEnd: bodyText.length > 1500 ? bodyText.slice(-1500) : '',
    url,
  };

  fs.mkdirSync(FIXTURES, { recursive: true });
  const out = path.join(FIXTURES, `${slugFor(url)}.json`);
  fs.writeFileSync(out, JSON.stringify(pageData, null, 2));
  console.log(`✓ ${out}  (${bodyText.length} chars, author=${pageData.author}, site=${pageData.siteName})`);
}

async function main() {
  let urls = process.argv.slice(2);
  if (urls.length === 0) {
    const listPath = path.join(__dirname, 'urls.txt');
    if (!fs.existsSync(listPath)) {
      console.error('No URLs given and bench/urls.txt not found.');
      process.exit(1);
    }
    urls = fs.readFileSync(listPath, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  }
  for (const url of urls) {
    try {
      await extract(url);
    } catch (err) {
      console.error(`✗ ${url}: ${err.message}`);
    }
  }
}

main();

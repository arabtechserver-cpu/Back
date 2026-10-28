/* Refresh the checked-in manual catalog. Only names and public identifiers are retained. */
const fs = require('node:fs/promises');
const path = require('node:path');
const origin = 'https://zoalna.sd';
const sections = [
  { id: 'top-up-id', slug: 'top-up-id', title: 'الشحن بالايدي', titleEn: 'Top up by ID', path: '/الشحن-عن-طريق-الid/' },
  { id: 'top-up-account', slug: 'top-up-acc', title: 'شحن بالحساب', titleEn: 'Account top-ups', path: '/top-up-acc/' },
  { id: 'game-cards', slug: 'game-cards', title: 'كروت الالعاب', titleEn: 'Game cards', path: '/game-cards/' },
  { id: 'digital-stores', slug: 'digital-stores', title: 'الاشتراكات الرقمية', titleEn: 'Digital subscriptions', path: '/digital-stores/' },
];
const decode = text => String(text ?? '').replace(/&#(x[\da-f]+|\d+);/gi, (_, n) => String.fromCodePoint(n[0].toLowerCase() === 'x' ? parseInt(n.slice(1),16) : Number(n)))
  .replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#0*39;|&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').trim();
async function get(url, json = false) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Catalog request failed: ${response.status} ${url}`);
  return json ? response.json() : response.text();
}
async function run() {
  const membership = new Map();
  for (const section of sections) {
    const html = await get(new URL(section.path, origin));
    for (const match of html.matchAll(/href=["']([^"']*\/product\/[^"']*)["']/g)) {
      const url = new URL(decode(match[1]), origin);
      if (url.origin !== origin) continue;
      const slug = url.pathname.split('/').filter(Boolean)[1];
      if (!membership.has(slug)) membership.set(slug, new Set());
      membership.get(slug).add(section.id);
    }
  }
  // The subscriptions banner links to a variable product rather than a category listing.
  membership.set('subscriber2', new Set(['digital-stores']));
  const products = [];
  for (let page = 1; ; page++) {
    const batch = await get(`${origin}/wp-json/wc/store/v1/products?per_page=100&page=${page}`, true);
    if (!Array.isArray(batch)) throw new Error('Unexpected product response');
    products.push(...batch);
    if (batch.length < 100) break;
  }
  const catalog = [];
  for (const [slug, pageIds] of membership) {
    const product = products.find(p => p.slug === slug);
    if (!product) throw new Error(`Missing source product: ${slug}`);
    let packages = (product.variations || []).filter(v => v.attributes?.some(a => a.value != null && String(a.value).trim())).map(v => ({
      id: String(v.id), name: (v.attributes || []).map(a => decode(a.value)).filter(Boolean).join(' / '),
    }));
    // Ignore stale variations without names; include every current named option.
    if (product.type === 'variable') {
      const attributes = (product.attributes || []).filter(a => a.has_variations);
      if (attributes.length === 1) {
        for (const [index, term] of attributes[0].terms.entries()) {
          const name = decode(term.name);
          if (!packages.some(p => p.name === name)) packages.push({ id: `${product.id}-option-${index + 1}`, name });
        }
      } else if (!packages.length) throw new Error(`Ambiguous variation attributes: ${slug}`);
    }
    packages = packages.filter((p,i,all) => all.findIndex(other => other.name===p.name)===i);
    if (packages.some(p => !p.name) || (product.type === 'variable' && !packages.length)) throw new Error(`Missing variation names: ${slug}`);
    const optionFields = (product.attributes || []).filter(a => a.has_variations && (product.variations || []).length && product.variations.every(v => !v.attributes.some(attribute => attribute.name === a.name && attribute.value != null))).map((a,i) => ({ key: `option_${i+1}`, label: decode(a.name), options: a.terms.map(t => decode(t.name)) }));
    catalog.push({ id: String(product.id), slug, name: decode(product.name), pageIds: [...pageIds], optionFields,
      packages: packages.length ? packages : [{ id: String(product.id), name: decode(product.name) }] });
  }
  const output = { version: 1, source: origin, capturedAt: new Date().toISOString(), sections, products: catalog };
  const destination = path.resolve(__dirname, '../src/data/zoalna-catalog.json');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, JSON.stringify(output, null, 2) + '\n');
  console.log(`Saved ${catalog.length} products, ${catalog.reduce((n,p) => n+p.packages.length,0)} packages and ${sections.length} pages (no prices).`);
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });

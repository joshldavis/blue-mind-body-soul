// Vercel Serverless Function: GET /api/shop-products
// Pulls published products from the BMBS Printify shop and returns a slim,
// public-safe JSON feed for /shop. The API token never reaches the browser.
//
// Environment variables (set in Vercel → Project → Settings → Environment Variables):
//   PRINTIFY_API_TOKEN   required  Personal access token (Printify → My Profile → Connections).
//                                  Scopes needed: shops.read, products.read
//   PRINTIFY_SHOP_ID     optional  Numeric shop id. If unset, the first shop whose title
//                                  matches "Blue Mind" (else the first shop) is used.
//   PRINTIFY_STORE_URL   optional  Public storefront. Default: https://blue-mind-body-soul.printify.me
//   PRINTIFY_INCLUDE_DRAFTS optional "1" also lists unpublished products (setup/preview only)
//
// Response: { configured, storeUrl, updated, products: [{ id, title, blurb, image, images,
//             priceMin, priceMax, currency, category, tags, url }] }
// Always answers 200 so the page can fall back gracefully; errors are logged server-side.

const API = 'https://api.printify.com/v1';
const DEFAULT_STORE = 'https://blue-mind-body-soul.printify.me';
const UA = 'BMBS-Site/1.0 (bluemindbodyandsoul.com)';

// Tag → display category. First match wins; anything else falls into "More".
const CATEGORY_RULES = [
  ['Apparel', /\b(t-?shirt|tee|hoodie|sweatshirt|crewneck|tank|apparel|shirt|leggings|joggers|hat|beanie|cap)\b/i],
  ['Drinkware', /\b(mug|tumbler|bottle|drinkware|cup|glass)\b/i],
  ['Journals & Paper', /\b(journal|notebook|planner|paper|poster|print|card|calendar)\b/i],
  ['Home', /\b(candle|pillow|blanket|towel|home|decor|coaster|mat)\b/i],
  ['Bags & Accessories', /\b(tote|bag|pouch|phone case|case|accessor)/i],
  ['Wellness', /\b(supplement|vitamin|gummies|serum|skincare|oil|tonic|protein|creatine|coffee|tea)\b/i],
  ['Stickers', /\bsticker/i],
];

function categorize(product) {
  const hay = [product.title, ...(product.tags || [])].join(' ');
  for (const [name, re] of CATEGORY_RULES) if (re.test(hay)) return name;
  return 'More';
}

function stripHtml(html = '') {
  return String(html)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|li|h\d)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function blurbOf(desc) {
  const text = stripHtml(desc);
  if (text.length <= 140) return text;
  const cut = text.slice(0, 140);
  return cut.slice(0, cut.lastIndexOf(' ')) + '…';
}

function productUrl(p, storeUrl) {
  const base = storeUrl.replace(/\/$/, '');
  const ext = p.external || {};
  if (ext.handle && /^https?:\/\//i.test(ext.handle)) return ext.handle;
  // Pop-Up Store product pages live at <store>/product/<external id>
  if (ext.id && /^\d+$/.test(String(ext.id))) return `${base}/product/${ext.id}`;
  if (ext.handle) return `${base}/${String(ext.handle).replace(/^\//, '')}`;
  return base;
}

async function pf(path, token) {
  const r = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': UA, Accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`Printify ${path} → ${r.status} ${await r.text().catch(() => '')}`.slice(0, 300));
  return r.json();
}

async function resolveShopId(token) {
  if (process.env.PRINTIFY_SHOP_ID) return process.env.PRINTIFY_SHOP_ID;
  const shops = await pf('/shops.json', token);
  if (!Array.isArray(shops) || !shops.length) throw new Error('No Printify shops on this account');
  const match = shops.find((s) => /blue\s*mind/i.test(s.title || ''));
  return (match || shops[0]).id;
}

function slim(p, storeUrl) {
  const enabled = (p.variants || []).filter((v) => v.is_enabled !== false && v.is_available !== false);
  const prices = enabled.map((v) => v.price).filter((n) => typeof n === 'number' && n > 0);
  if (!prices.length) return null;
  const imgs = (p.images || []).slice().sort((a, b) => (b.is_default === true) - (a.is_default === true));
  const image = imgs[0] && imgs[0].src;
  if (!image) return null;
  return {
    id: p.id,
    title: p.title,
    blurb: blurbOf(p.description),
    image,
    images: imgs.slice(0, 4).map((i) => i.src),
    priceMin: Math.min(...prices) / 100,
    priceMax: Math.max(...prices) / 100,
    currency: 'USD',
    category: categorize(p),
    tags: (p.tags || []).slice(0, 8),
    from: prices.length > 1 && Math.min(...prices) !== Math.max(...prices),
    url: productUrl(p, storeUrl),
    created: p.created_at || null,
  };
}

async function handler(req, res) {
  const storeUrl = process.env.PRINTIFY_STORE_URL || DEFAULT_STORE;
  const token = process.env.PRINTIFY_API_TOKEN;
  const send = (status, body, cache) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', cache);
    res.statusCode = status;
    res.end(JSON.stringify(body));
  };

  if (!token) {
    return send(200, { configured: false, storeUrl, products: [] }, 'public, s-maxage=300');
  }

  try {
    const shopId = await resolveShopId(token);
    const all = [];
    for (let page = 1; page <= 6; page++) {
      const data = await pf(`/shops/${shopId}/products.json?limit=50&page=${page}`, token);
      const rows = (data && data.data) || [];
      all.push(...rows);
      if (!data || !data.last_page || page >= data.last_page) break;
    }
    const products = all
      // Only products that are visible AND published to a sales channel (drafts have no `external`).
      // Set PRINTIFY_INCLUDE_DRAFTS=1 to preview unpublished products while setting up.
      .filter((p) => p.visible !== false && (process.env.PRINTIFY_INCLUDE_DRAFTS === '1' || (p.external && p.external.id)))
      .map((p) => slim(p, storeUrl))
      .filter(Boolean)
      .sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')));

    // Fresh for 15 min at the edge, served stale for up to a day while refreshing.
    return send(
      200,
      { configured: true, storeUrl, updated: new Date().toISOString(), products },
      'public, s-maxage=900, stale-while-revalidate=86400'
    );
  } catch (err) {
    console.error('[shop-products]', err && err.message);
    return send(200, { configured: true, error: true, storeUrl, products: [] }, 'public, s-maxage=60');
  }
}

module.exports = handler;
module.exports._internal = { categorize, blurbOf, productUrl, slim };

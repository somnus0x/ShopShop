import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { defineTool, toolResult } from './mcp-tool.mjs';

export const defaultProductDetails = fileURLToPath(new URL('../catalog/instagram/catalog.json', import.meta.url));
export const productId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const merchantHandle = z.string().regex(/^[a-zA-Z0-9._]{1,30}$/);

const instagramUrl = z.url({ protocol: /^https$/, hostname: /^www\.instagram\.com$/ });
const productEntry = z.object({
  product_id: productId,
  name: z.string().trim().min(1).max(200),
  name_source: z.enum(['caption', 'image_text', 'visual_description']),
  merchant: merchantHandle,
  description: z.string(),
  price: z.number().nonnegative().nullable(),
  currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  price_status: z.literal('conflicting').optional(),
  variants: z.array(z.string()),
  post_url: instagramUrl,
  post_date: z.iso.datetime().nullable(),
  notes: z.array(z.string()),
  images: z.array(z.object({ local_path: z.string().min(1), alt: z.string(), post_url: instagramUrl })).min(1),
});
const catalogSchema = z.object({ capture_date: z.iso.date(), products: z.array(productEntry) });
const pictureMimeTypes = new Map([['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'], ['.webp', 'image/webp']]);
const maxPictureBytes = 1024 * 1024;

export function loadProductDetails(path = defaultProductDetails) {
  const catalogPath = realpathSync(path);
  const catalog = catalogSchema.parse(JSON.parse(readFileSync(catalogPath, 'utf8')));
  const byId = new Map(catalog.products.map(product => [product.product_id, product]));
  if (byId.size !== catalog.products.length) throw new Error('Duplicate product ID in product details catalog');
  return { ...catalog, byId, directory: dirname(catalogPath) };
}

function pictureUrl(product_id, picture_index) {
  return '/api/products/' + encodeURIComponent(product_id) + '/pictures/' + picture_index;
}

export function listProducts(catalog, { query = '', merchant, offset = 0, limit = 20 }) {
  const search = query.toLowerCase();
  const handle = merchant?.replace(/^@/, '').toLowerCase();
  const matches = catalog.products.filter(product => {
    if (handle && product.merchant.toLowerCase() !== handle) return false;
    const terms = [product.name, product.product_id, product.merchant, product.description, ...product.variants];
    return terms.some(term => term.toLowerCase().includes(search));
  });
  const products = matches.slice(offset, offset + limit).map(product => ({
    product_id: product.product_id,
    name: product.name,
    merchant: product.merchant,
    price: product.price,
    currency: product.currency,
    picture_count: product.images.length,
    image_url: pictureUrl(product.product_id, 1),
    image_urls: product.images.map((_, index) => pictureUrl(product.product_id, index + 1)),
  }));
  return { products, total: matches.length, next_offset: offset + limit < matches.length ? offset + limit : null };
}

export function getProductJson(catalog, product_id) {
  const product = catalog.byId.get(product_id);
  if (!product) throw new Error('Product not found');
  const { images, ...details } = product;
  const pictures = images.map(({ alt, post_url }, index) => ({
    picture_index: index + 1, alt, post_url,
    url: pictureUrl(product_id, index + 1),
  }));
  return { product: { ...details, pictures }, capture_date: catalog.capture_date };
}

export function getProductPicture(catalog, product_id, picture_index) {
  const product = catalog.byId.get(product_id);
  if (!product) throw new Error('Product not found');
  const picture = product.images[picture_index - 1];
  if (!picture) throw new Error('Picture index out of range');
  const image = readPicture(catalog.directory, picture.local_path);
  return { mimeType: image.mimeType, data: Buffer.from(image.data, 'base64') };
}

function readPicture(directory, localPath) {
  if (isAbsolute(localPath)) throw new Error('Product picture unavailable');
  try {
    const path = realpathSync(resolve(directory, localPath));
    const fromCatalog = relative(directory, path);
    if (fromCatalog === '..' || fromCatalog.startsWith('..' + sep) || isAbsolute(fromCatalog)) {
      throw new Error('Picture path is outside the catalog');
    }
    const mimeType = pictureMimeTypes.get(extname(path).toLowerCase());
    const file = statSync(path);
    if (!mimeType || !file.isFile() || file.size > maxPictureBytes || file.size === 0) throw new Error('Invalid picture');
    return { type: 'image', mimeType, data: readFileSync(path).toString('base64') };
  } catch {
    throw new Error('Product picture unavailable');
  }
}

function getProduct(catalog, { product_id, picture_index = 1 }) {
  const product = catalog.byId.get(product_id);
  if (!product) throw new Error('Product not found');
  const { images, ...details } = product;
  const selected = images[picture_index - 1];
  if (!selected) throw new Error('Picture index out of range');
  const pictures = images.map(({ alt, post_url }, index) => ({ picture_index: index + 1, alt, post_url }));
  const result = { product: { ...details, pictures }, picture_index, capture_date: catalog.capture_date };
  return toolResult(result, [readPicture(catalog.directory, selected.local_path)]);
}

export function productCatalogTools(catalog) {
  if (!catalog) return [];
  return [
    defineTool('list_products', 'Find products in the saved Instagram catalog. Returns product IDs and summaries. Filter by merchant or search by name, model code, or detail. Use get_product for the full record and picture.', z.strictObject({
      query: z.string().trim().min(1).max(200).optional(),
      merchant: z.string().regex(/^@?[a-zA-Z0-9._]{1,30}$/).optional(),
      offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 50).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }), args => toolResult(listProducts(catalog, args)), true),
    defineTool('get_product', 'Retrieve a product by its catalog ID. Returns the name, description, variants, listed price, source post, and one saved picture as MCP image content. Set picture_index (1-based) to view another picture.', z.strictObject({
      product_id: productId,
      picture_index: z.number().int().min(1).optional(),
    }), args => getProduct(catalog, args), true),
  ];
}

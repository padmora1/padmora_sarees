// Shared row -> API-shape mapping, used by both the public /api/products
// routes and the /api/admin/products routes so the two never drift apart
// (the admin editor reads exactly the same field names the storefront does).
function toVariantApiShape(v) {
  return {
    id: v.id,
    productId: v.product_id,
    colorName: v.color_name,
    swatch: v.swatch,
    sku: v.sku,
    price: v.price,
    mrp: v.mrp,
    stock: v.stock,
    lowStockThreshold: v.low_stock_threshold,
    desc: v.description,
    isDefault: !!v.is_default,
    media: (v.media || []).map(m => ({ id: m.id, type: m.type, url: m.url, alt: m.alt_text, isPrimary: !!m.is_primary }))
  };
}

function toProductApiShape(row) {
  return {
    id: row.id,
    name: row.name,
    fabric: row.fabric,
    occasion: row.occasion,
    price: row.price,
    mrp: row.mrp,
    rating: row.rating,
    reviews: row.reviews_count,
    badge: row.badge,
    swatch: row.swatch,
    desc: row.description,
    stock: row.stock,
    status: row.status || 'active',
    weaverName: row.weaver_name,
    weaverRegion: row.weaver_region,
    loomType: row.loom_type,
    reelVideo: row.reel_video,
    reelThumbnail: row.reel_thumbnail,
    // Real, independently-priced/stocked color options — the default variant's
    // numbers are mirrored in the flat fields above for backward compatibility.
    variants: (row.variants || []).map(toVariantApiShape)
  };
}

module.exports = { toProductApiShape, toVariantApiShape };

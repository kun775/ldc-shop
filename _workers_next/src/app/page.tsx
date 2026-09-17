import { getActiveProductCategories, getCategories, getActiveProducts, getVisitorCount, getUserPendingOrders, getSetting } from "@/lib/db/queries";
import { getActiveAnnouncement } from "@/actions/settings";
import { auth } from "@/lib/auth";
import { HomeContent } from "@/components/home-content";
import { INFINITE_STOCK } from "@/lib/constants";

const PAGE_SIZE = 24;

function stripMarkdown(input: string): string {
  return input
    .replace(/!\[.*?\]\(.*?\)/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/[`*_>#+-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveProductStockCount(product: any): number {
  const isGroup = product.allVariantIds && product.allVariantIds.length > 1;
  if (isGroup) {
    const totalStock = Number(product.totalStock || 0);
    const totalLocked = Number(product.totalLocked || 0);
    if ((product.groupShared && totalStock > 0) || totalStock >= INFINITE_STOCK) {
      return INFINITE_STOCK;
    }
    return totalStock + totalLocked;
  }

  const stock = Number(product.stock || 0);
  const locked = Number(product.locked || 0);
  if (product.fulfillmentMode === 'manual') return stock;
  if (product.isShared) return stock > 0 ? INFINITE_STOCK : 0;
  return stock >= INFINITE_STOCK ? INFINITE_STOCK : stock + locked;
}

export default async function Home({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const resolved = searchParams ? await searchParams : {}
  const q = (typeof resolved.q === 'string' ? resolved.q : '').trim();
  const categoryParam = (typeof resolved.category === 'string' ? resolved.category : '').trim();
  const category = categoryParam && categoryParam !== 'all' ? categoryParam : '';
  const sort = (typeof resolved.sort === 'string' ? resolved.sort : 'default').trim();
  const page = Math.max(1, Number.parseInt(typeof resolved.page === 'string' ? resolved.page : '1', 10) || 1);

  const session = await auth()
  const isLoggedIn = !!session?.user
  const trustLevel = Number.isFinite(Number(session?.user?.trustLevel)) ? Number(session?.user?.trustLevel) : 0

  // Run all independent queries in parallel for better performance
  const [products, announcement, visitorCount, categoryConfig, productCategories, wishlistEnabled, checkinEnabled] = await Promise.all([
    getActiveProducts({ isLoggedIn, trustLevel }).catch(() => []),
    getActiveAnnouncement().catch(() => null),
    getVisitorCount().catch(() => 0),
    getCategories().catch(() => []),
    getActiveProductCategories({ isLoggedIn, trustLevel }).catch(() => []),
    (async () => {
      try {
        return (await getSetting('wishlist_enabled')) === 'true'
      } catch {
        return false
      }
    })(),
    (async () => {
      try {
        return (await getSetting('checkin_enabled')) !== 'false'
      } catch {
        return true
      }
    })()
  ]);


  const total = products.length;

  const productsWithRatings = products.map((p: any) => {
    const isGroup = p.allVariantIds && p.allVariantIds.length > 1;

    return {
      ...p,
      pointDiscountEnabled: Boolean(p.pointDiscountEnabled),
      pointDiscountPercent: Number(p.pointDiscountPercent || 0),
      stockCount: resolveProductStockCount(p),
      soldCount: isGroup ? (p.totalSold || 0) : (p.sold || 0),
      isHot: isGroup ? (p.groupHot || false) : p.isHot,
      descriptionPlain: stripMarkdown(p.description || ''),
      rating: isGroup ? Number(p.avgRating || 0) : Number(p.rating || 0),
      reviewCount: isGroup ? Number(p.totalReviewCount || 0) : Number(p.reviewCount || 0)
    };
  });

  // Check for pending orders (depends on session)
  let pendingOrders: any[] = [];
  if (session?.user?.id) {
    try {
      pendingOrders = await getUserPendingOrders(session.user.id);
    } catch {
      // Ignore errors fetching pending orders
    }
  }

  const categoryNames = categoryConfig
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))
    .map((c) => c.name);
  const extraCategories = productCategories.filter((c) => !categoryNames.includes(c)).sort();
  const categories = [...categoryNames, ...extraCategories];

  return <HomeContent
    products={productsWithRatings}
    announcement={announcement}
    visitorCount={visitorCount}
    categories={categories}
    categoryConfig={categoryConfig}
    pendingOrders={pendingOrders}
    wishlistEnabled={wishlistEnabled}
    isLoggedIn={isLoggedIn}
    checkinEnabled={checkinEnabled}
    filters={{ q, category: category || null, sort }}
    pagination={{ page, pageSize: PAGE_SIZE, total }}
  />;
}

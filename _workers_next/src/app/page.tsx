import { getActiveProductCategories, getCategories, searchActiveProducts, getUserPendingOrders } from "@/lib/db/queries";
import { getActiveAnnouncement } from "@/actions/settings";
import { auth } from "@/lib/auth";
import { HomeContent, type HomeFilters } from "@/components/home-content";

const PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 60;

const ALLOWED_SORTS = new Set(['default', 'stockDesc', 'soldDesc', 'priceAsc', 'priceDesc', 'hot']);
const ALLOWED_FULFILLMENT = new Set(['all', 'auto', 'manual', 'inStock']);

function firstParam(value: string | string[] | undefined): string {
  if (!value) return '';
  return (Array.isArray(value) ? value[0] : value).trim();
}

function parseIntParam(value: string, fallback: number) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function stripMarkdown(input: string): string {
  return input
    .replace(/!\[.*?\]\(.*?\)/g, '')
    .replace(/\[(.*?)\]\(.*?\)/g, '$1')
    .replace(/[`*_>#+-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export default async function Home({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const resolved = searchParams ? await searchParams : {};

  // 筛选/排序/分页全部在服务端解析并下推到 SQL —— 客户端只接收当前这一页。
  // 未知取值一律回退到默认值，避免把任意字符串透传进查询构造。
  const q = firstParam(resolved.q).slice(0, 100);
  const categoryParam = firstParam(resolved.category);
  const category = categoryParam && categoryParam !== 'all' ? categoryParam.slice(0, 100) : '';
  const sortParam = firstParam(resolved.sort) || 'default';
  const sort = ALLOWED_SORTS.has(sortParam) ? sortParam : 'default';
  const fulfillmentParam = firstParam(resolved.fulfillment) || 'all';
  const fulfillment = ALLOWED_FULFILLMENT.has(fulfillmentParam) ? fulfillmentParam : 'all';
  const page = parseIntParam(firstParam(resolved.page), 1);
  const pageSize = Math.min(parseIntParam(firstParam(resolved.pageSize), PAGE_SIZE), MAX_PAGE_SIZE);

  const session = await auth()
  const isLoggedIn = !!session?.user
  const trustLevel = Number.isFinite(Number(session?.user?.trustLevel)) ? Number(session?.user?.trustLevel) : 0

  // Run all independent queries in parallel for better performance
  // 注意：首页此前还顺手取了访客数与两个开关，但它们从未被 HomeContent 使用
  // （访客数由 site-footer 自己取），属于每个 PV 白搭的 D1 往返，已移除。
  const [productResult, announcement, categoryConfig, productCategories] = await Promise.all([
    searchActiveProducts({ q, category, sort, fulfillment, page, pageSize, isLoggedIn, trustLevel })
      .catch(() => ({ items: [] as any[], total: 0, page, pageSize })),
    getActiveAnnouncement().catch(() => null),
    getCategories().catch(() => []),
    getActiveProductCategories({ isLoggedIn, trustLevel }).catch(() => []),
  ]);

  const products = productResult.items.map((p: any) => {
    const isGroup = p.variantCount != null && p.variantCount > 1;

    return {
      id: p.id,
      name: p.name,
      // 商品描述只下发纯文本摘要：列表最多渲染两行，Markdown 原文留在服务端。
      descriptionPlain: stripMarkdown(p.description || ''),
      price: p.price,
      compareAtPrice: p.compareAtPrice ?? null,
      pointDiscountEnabled: Boolean(p.pointDiscountEnabled),
      pointDiscountPercent: Number(p.pointDiscountPercent || 0),
      image: p.image,
      category: p.category,
      // stockCount 由查询层按统一口径（卡密 / 手动库存 / 共享卡 / 变体聚合）算好
      stockCount: Number(p.stockCount || 0),
      soldCount: isGroup ? Number(p.totalSold || 0) : Number(p.sold || 0),
      isHot: isGroup ? Boolean(p.groupHot) : Boolean(p.isHot),
      rating: isGroup ? Number(p.avgRating || 0) : Number(p.rating || 0),
      reviewCount: isGroup ? Number(p.totalReviewCount || 0) : Number(p.reviewCount || 0),
      variantCount: p.variantCount ?? undefined,
      priceMin: p.priceMin ?? undefined,
      priceMax: p.priceMax ?? undefined,
      fulfillmentMode: p.fulfillmentMode ?? null,
      groupManual: Boolean(p.groupManual),
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

  const filters: HomeFilters = { q, category, sort, fulfillment };

  return <HomeContent
    products={products}
    total={productResult.total}
    page={productResult.page}
    pageSize={productResult.pageSize}
    filters={filters}
    announcement={announcement}
    categories={categories}
    categoryConfig={categoryConfig}
    pendingOrders={pendingOrders}
  />;
}

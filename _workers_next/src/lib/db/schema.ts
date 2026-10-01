import { sqliteTable, text, integer, blob, primaryKey, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

// Products
export const products = sqliteTable('products', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    price: text('price').notNull(), // SQLite doesn't have decimal, use text for precision
    compareAtPrice: text('compare_at_price'),
    category: text('category'),
    image: text('image'),
    productImages: text('product_images'),
    isHot: integer('is_hot', { mode: 'boolean' }).default(false),
    isActive: integer('is_active', { mode: 'boolean' }).default(true),
    isShared: integer('is_shared', { mode: 'boolean' }).default(false),
    sortOrder: integer('sort_order').default(0),
    purchaseLimit: integer('purchase_limit'),
    purchaseWarning: text('purchase_warning'), // Optional warning message shown before purchase
    visibilityLevel: integer('visibility_level').default(-1),
    pointDiscountEnabled: integer('point_discount_enabled', { mode: 'boolean' }).default(false),
    pointDiscountPercent: integer('point_discount_percent').default(0),
    manualStockCount: integer('manual_stock_count').default(0).notNull(),
    stockCount: integer('stock_count').default(0),
    lockedCount: integer('locked_count').default(0),
    soldCount: integer('sold_count').default(0),
    rating: integer('rating', { mode: 'number' }).default(0), // Average rating (stored as integer/real but using number mode for safety with existing code if it was float. Actually sqliteTable 'integer' is usually int. Better use 'real' for average, but Drizzle sqlite-core uses 'real' or 'numeric'. Let's check imports.)
    reviewCount: integer('review_count').default(0),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()), // Use integer timestamp (ms)
    variantGroupId: text('variant_group_id'),
    variantLabel: text('variant_label'),
    purchaseQuestions: text('purchase_questions'),
    checkoutFields: text('checkout_fields'),
    fulfillmentMode: text('fulfillment_mode').default('auto'),
    couponUsageRestriction: text('coupon_usage_restriction').notNull().default('all'),
});

// Cards (Stock)
export const cards = sqliteTable('cards', {
    id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
    productId: text('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
    cardKey: text('card_key').notNull(),
    isUsed: integer('is_used', { mode: 'boolean' }).default(false),
    reservedOrderId: text('reserved_order_id'),
    reservedAt: integer('reserved_at', { mode: 'timestamp_ms' }),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }),
    usedAt: integer('used_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
});

// Orders
export const orders = sqliteTable('orders', {
    orderId: text('order_id').primaryKey(),
    productId: text('product_id').notNull(),
    productName: text('product_name').notNull(),
    amount: text('amount').notNull(),
    email: text('email'),
    status: text('status').default('pending'), // pending, paid, delivered, failed, refunded
    tradeNo: text('trade_no'),
    cardKey: text('card_key'),
    cardIds: text('card_ids'),
    paidAt: integer('paid_at', { mode: 'timestamp_ms' }),
    deliveredAt: integer('delivered_at', { mode: 'timestamp_ms' }),
    userId: text('user_id'),
    username: text('username'),
    payee: text('payee'),
    pointsUsed: integer('points_used').default(0),
    quantity: integer('quantity').default(1).notNull(),
    manualStockQuantity: integer('manual_stock_quantity').default(0).notNull(),
    currentPaymentId: text('current_payment_id'),
    checkoutFieldValues: text('checkout_field_values'),
    fulfillmentMode: text('fulfillment_mode').default('auto'),
    deliveryNote: text('delivery_note'),
    fulfillmentClaimId: text('fulfillment_claim_id'),
    fulfillmentClaimedAt: integer('fulfillment_claimed_at', { mode: 'timestamp_ms' }),
    subtotalAmountCents: integer('subtotal_amount_cents'),
    couponDiscountAmountCents: integer('coupon_discount_amount_cents').default(0),
    pointsDiscountAmountCents: integer('points_discount_amount_cents').default(0),
    pricingSnapshot: text('pricing_snapshot'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
});

// Coupons (discount definitions)
export const coupons = sqliteTable('coupons', {
    id: text('id').primaryKey(),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    discountType: text('discount_type').notNull().default('fixed'), // percent, fixed, threshold_fixed
    rateBps: integer('rate_bps'),
    discountAmountCents: integer('discount_amount_cents'),
    minSpendCents: integer('min_spend_cents').default(0).notNull(),
    maxDiscountCents: integer('max_discount_cents'),
    scope: text('scope').notNull().default('all'), // all, selected
    totalUseLimit: integer('total_use_limit'),
    perUserLimit: integer('per_user_limit'),
    reservedCount: integer('reserved_count').default(0).notNull(),
    consumedCount: integer('consumed_count').default(0).notNull(),
    stackableWithCoupons: integer('stackable_with_coupons', { mode: 'boolean' }).default(false),
    stackableWithPoints: integer('stackable_with_points', { mode: 'boolean' }).default(true),
    refundPolicy: text('refund_policy').default('unfulfilled_full_refund').notNull(),
    status: text('status').notNull().default('draft'), // draft, active, disabled
    startsAt: integer('starts_at', { mode: 'timestamp_ms' }),
    endsAt: integer('ends_at', { mode: 'timestamp_ms' }),
    createdBy: text('created_by'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
});

// Coupon -> product scope mapping
export const couponProducts = sqliteTable('coupon_products', {
    couponId: text('coupon_id').notNull(),
    productId: text('product_id').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
}, (table) => [
    primaryKey({ columns: [table.couponId, table.productId] }),
]);

// Coupon usage ledger (reserve / consume / release / reverse)
export const couponUsages = sqliteTable('coupon_usages', {
    id: text('id').primaryKey(),
    couponId: text('coupon_id').notNull(),
    orderId: text('order_id').notNull(),
    userId: text('user_id'),
    username: text('username'),
    status: text('status').notNull().default('reserved'), // reserved, consumed, released, reversed
    sequence: integer('sequence').default(0).notNull(),
    reservationId: text('reservation_id').notNull(),
    reservationExpiresAt: integer('reservation_expires_at', { mode: 'timestamp_ms' }),
    couponCodeSnapshot: text('coupon_code_snapshot').notNull(),
    ruleSnapshot: text('rule_snapshot').notNull(),
    eligibleAmountCents: integer('eligible_amount_cents').default(0).notNull(),
    discountAmountCents: integer('discount_amount_cents').default(0).notNull(),
    reservedAt: integer('reserved_at', { mode: 'timestamp_ms' }),
    consumedAt: integer('consumed_at', { mode: 'timestamp_ms' }),
    releasedAt: integer('released_at', { mode: 'timestamp_ms' }),
    reversedAt: integer('reversed_at', { mode: 'timestamp_ms' }),
    reason: text('reason'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
});

// Per-user coupon counters for atomic per-user quota enforcement
export const couponUserCounters = sqliteTable('coupon_user_counters', {
    couponId: text('coupon_id').notNull(),
    userId: text('user_id').notNull(),
    reservedCount: integer('reserved_count').default(0).notNull(),
    consumedCount: integer('consumed_count').default(0).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
}, (table) => [
    primaryKey({ columns: [table.couponId, table.userId] }),
]);


export const orderDeliveryFiles = sqliteTable('order_delivery_files', {
    id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
    orderId: text('order_id').notNull(),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    size: integer('size').notNull(),
    storage: text('storage').notNull(),
    objectKey: text('object_key'),
    content: blob('content'),
    downloadedAt: integer('downloaded_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
});

// Logged-in users (for visitor counts)
export const loginUsers = sqliteTable('login_users', {
    userId: text('user_id').primaryKey(),
    username: text('username'),
    nickname: text('nickname'),
    email: text('email'),
    points: integer('points').default(0).notNull(),
    isBlocked: integer('is_blocked', { mode: 'boolean' }).default(false),
    desktopNotificationsEnabled: integer('desktop_notifications_enabled', { mode: 'boolean' }).default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
    lastLoginAt: integer('last_login_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
    lastCheckinAt: integer('last_checkin_at', { mode: 'timestamp_ms' }),
    consecutiveDays: integer('consecutive_days').default(0),
});

export const userPointLedger = sqliteTable('user_point_ledger', {
    id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
    userId: text('user_id').notNull(),
    eventType: text('event_type').notNull(),
    delta: integer('delta').notNull(),
    balanceAfter: integer('balance_after'),
    businessKey: text('business_key').notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id'),
    reason: text('reason').notNull(),
    operatorUserId: text('operator_user_id'),
    operatorUsername: text('operator_username'),
    metadata: text('metadata'),
    status: text('status').default('completed').notNull(),
    claimId: text('claim_id'),
    claimedAt: integer('claimed_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
});

// Daily Check-ins
export const dailyCheckins = sqliteTable('daily_checkins_v2', {
    id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
    userId: text('user_id').notNull().references(() => loginUsers.userId, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
});
// Note: Unique index logic for 'userDateUnique' needs Drizzle SQLite specific syntax or raw SQL if not supported directly in schema builder yet, 
// but for now relying on application application level check or standard unique() if supported.
// Actually Drizzle SQLite supports unique(). 
// But complex index on function date(createdAt) might need pure SQL or separate index definition.
// For D1/SQLite, we can't easily index on function in Drizzle schema builder directly easily without `generated always as`.
// We will handle the "check in once per day" logic in application code query or redundant column if needed.
// However, checking the migration logic later is cleaner.

// Settings
export const settings = sqliteTable('settings', {
    key: text('key').primaryKey(),
    value: text('value'),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
});

// Versioned database upgrade execution history
export const databaseMigrations = sqliteTable('database_migrations', {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    status: text('status').default('running').notNull(),
    claimId: text('claim_id'),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }),
    executedAt: integer('executed_at', { mode: 'timestamp_ms' }),
    durationMs: integer('duration_ms'),
    errorId: text('error_id'),
    errorMessage: text('error_message'),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
});

// Reviews
export const reviews = sqliteTable('reviews', {
    id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
    productId: text('product_id').notNull().references(() => products.id, { onDelete: 'cascade' }),
    orderId: text('order_id').notNull(),
    userId: text('user_id').notNull(),
    username: text('username').notNull(),
    rating: integer('rating').notNull(), // 1-5 stars
    comment: text('comment'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
});

export const reviewReplies = sqliteTable('review_replies', {
    id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
    reviewId: integer('review_id', { mode: 'number' }).notNull().references(() => reviews.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    username: text('username').notNull(),
    comment: text('comment').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
});

// Categories
export const categories = sqliteTable('categories', {
    id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    icon: text('icon'),
    sortOrder: integer('sort_order').default(0),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
});

// Refund requests
export const refundRequests = sqliteTable('refund_requests', {
    id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
    orderId: text('order_id').notNull(),
    userId: text('user_id'),
    username: text('username'),
    reason: text('reason'),
    status: text('status').default('pending'),
    adminUsername: text('admin_username'),
    adminNote: text('admin_note'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
    processedAt: integer('processed_at', { mode: 'timestamp_ms' }),
});

// User notifications (inbox)
export const userNotifications = sqliteTable('user_notifications', {
    id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
    userId: text('user_id').notNull().references(() => loginUsers.userId, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    titleKey: text('title_key').notNull(),
    contentKey: text('content_key').notNull(),
    data: text('data'),
    isRead: integer('is_read', { mode: 'boolean' }).default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
});

// Admin broadcast messages (history)
export const adminMessages = sqliteTable('admin_messages', {
    id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
    targetType: text('target_type').notNull(),
    targetValue: text('target_value'),
    title: text('title').notNull(),
    body: text('body').notNull(),
    sender: text('sender'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
});

// User -> Admin messages
export const userMessages = sqliteTable('user_messages', {
    id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
    userId: text('user_id').notNull().references(() => loginUsers.userId, { onDelete: 'cascade' }),
    username: text('username'),
    title: text('title').notNull(),
    body: text('body').notNull(),
    isRead: integer('is_read', { mode: 'boolean' }).default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
});

// Broadcast messages (to all users)
export const broadcastMessages = sqliteTable('broadcast_messages', {
    id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
    title: text('title').notNull(),
    body: text('body').notNull(),
    sender: text('sender'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
});

// Broadcast read receipts (per user)
export const broadcastReads = sqliteTable('broadcast_reads', {
    id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
    messageId: integer('message_id').notNull().references(() => broadcastMessages.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => loginUsers.userId, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
});

// Wishlist items (user submitted ideas)
export const wishlistItems = sqliteTable('wishlist_items', {
    id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
    title: text('title').notNull(),
    description: text('description'),
    userId: text('user_id'),
    username: text('username'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
});

// Wishlist votes (per user)
export const wishlistVotes = sqliteTable('wishlist_votes', {
    id: integer('id', { mode: 'number' }).primaryKey({ autoIncrement: true }),
    itemId: integer('item_id').notNull().references(() => wishlistItems.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull().references(() => loginUsers.userId, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).$defaultFn(() => new Date()),
});

/**
 * 通用卡密服务（license-key-service）远端库存账本。
 *
 * 这里的表**一律不加外键**，与 `src/lib/db/license-service-schema.ts` 的 DDL 常量
 * 保持一致：本地 `cards`/`orders` 存在管理端删除与过期清理路径，外键会把这些
 * 路径变成级联删除或约束冲突，而「已售远端卡与映射不可随订单删除而丢失」
 * 只能由应用层守卫保证。结构定义（DDL）以 `license-service-schema.ts` 为唯一来源，
 * 本处仅提供 ORM 类型，两边的名字/字段必须逐一对齐。
 */

// 补货任务台账（Allocate 结果 + Ack 状态 + 本地 expires_at）
export const cardServiceAllocations = sqliteTable('card_service_allocations', {
    allocationId: text('allocation_id').primaryKey(),
    productId: text('product_id').notNull(),
    programKey: text('program_key').notNull(),
    externalRef: text('external_ref').notNull(),
    quantity: integer('quantity').notNull(),
    state: text('state').notNull(), // allocated | acknowledged | sold | expired | cancelled | abandoned
    requestKey: text('request_key').notNull(),
    ackKey: text('ack_key').notNull(),
    // 中心列表接口不返回 expires_at（N3），超窗调度只能靠本地这份记录。
    expiresAt: integer('expires_at').notNull(),
    ackedAt: integer('acked_at'),
    soldAt: integer('sold_at'),
    lastErrorCode: text('last_error_code'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
}, (table) => [
    uniqueIndex('card_service_allocations_external_ref_uq').on(table.externalRef),
]);

// 已领到但尚未 Ack 的卡密（不可售暂存），Ack 成功后搬入 `cards`
export const cardServiceStagedCards = sqliteTable('card_service_staged_cards', {
    remoteCardId: text('remote_card_id').primaryKey(),
    allocationId: text('allocation_id').notNull(),
    productId: text('product_id').notNull(),
    cardKey: text('card_key').notNull(),
    maskedKey: text('masked_key'),
    createdAt: integer('created_at').notNull(),
}, (table) => [
    index('card_service_staged_cards_allocation_idx').on(table.allocationId),
]);

// 本地卡 ↔ 远端卡映射（local_card_id 复用 cards.id）
export const cardServiceCards = sqliteTable('card_service_cards', {
    localCardId: integer('local_card_id').primaryKey(),
    remoteCardId: text('remote_card_id').notNull(),
    allocationId: text('allocation_id').notNull(),
    productId: text('product_id').notNull(),
    orderId: text('order_id'),
    state: text('state').notNull(),
    soldAt: integer('sold_at'),
    revokedAt: integer('revoked_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
}, (table) => [
    uniqueIndex('card_service_cards_remote_uq').on(table.remoteCardId),
    index('card_service_cards_order_idx').on(table.orderId),
    index('card_service_cards_allocation_idx').on(table.allocationId),
]);

// 待重试操作账本（Ack / Sell / Revoke 的可重放意图）
export const cardServiceOperations = sqliteTable('card_service_operations', {
    operationKey: text('operation_key').primaryKey(),
    operation: text('operation').notNull(),
    resourceId: text('resource_id').notNull(),
    orderId: text('order_id'),
    state: text('state').notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextRetryAt: integer('next_retry_at'),
    requestId: text('request_id'),
    lastErrorCode: text('last_error_code'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
}, (table) => [
    index('card_service_operations_state_idx').on(table.state, table.nextRetryAt),
]);

// 商品 → 供应模式 / Program 映射（服务端管理，无配置行时回落到 local）
export const cardServiceProductConfigs = sqliteTable('card_service_product_configs', {
    productId: text('product_id').primaryKey(),
    supplyMode: text('supply_mode').notNull().default('local'), // local | legacy_get | license_service
    programKey: text('program_key'),
    targetStock: integer('target_stock'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
});

// 只保存密文；按商品和 Program 保留历史凭据，用于旧卡销售及作废。
export const cardServiceCredentials = sqliteTable('card_service_credentials', {
    productId: text('product_id').notNull(),
    programKey: text('program_key').notNull(),
    encryptedApiKey: text('encrypted_api_key').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
}, (table) => [primaryKey({ columns: [table.productId, table.programKey] })]);

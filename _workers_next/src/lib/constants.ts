export const INFINITE_STOCK = 999999;
export const RESERVATION_TTL_MS = 5 * 60 * 1000;
export const LOGIN_HEARTBEAT_TTL_MS = 10 * 60 * 1000;

/**
 * 共享商品「随机取一张可用卡」的候选窗口上限。
 *
 * 直接用 `ORDER BY RANDOM()` 会让 SQLite 把该商品**全部**可用卡都扫出来再排序，
 * 属于写路径上随库存线性增长的隐藏开销。改成先按 id 取一个有界窗口
 * （只走 product_id 索引，读取上限固定），再在窗口内随机，效果上仍是分散取卡，
 * 但代价被钉死。窗口取值远大于「共享账号」这类商品的合理并发面。
 */
export const SHARED_CARD_CANDIDATE_WINDOW = 200;

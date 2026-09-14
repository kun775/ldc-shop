import cron from 'node-cron';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || `http://localhost:${process.env.PORT || 3000}`;
const CRON_TOKEN = process.env.CRON_CLEANUP_TOKEN || process.env.OAUTH_CLIENT_SECRET || '';

cron.schedule('*/5 * * * *', async () => {
    try {
        const res = await fetch(`${APP_URL}/api/internal/cron/cleanup`, {
            method: 'POST',
            headers: { 'x-cron-cleanup-token': CRON_TOKEN },
        });
        if (!res.ok) {
            console.error(`[cron] cleanup failed: ${res.status}`);
        }
    } catch (err) {
        console.error('[cron] cleanup error:', err.message);
    }
});

console.log('[cron] Cleanup scheduler started (every 5 minutes)');

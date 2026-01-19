export const config = { runtime: 'nodejs' };

/**
 * Push leavesUpdatesNext14 payload to the Hub's stats-ingest endpoint.
 * Env:
 * - HUB_STATS_INGEST_URL (default: https://hub.projectx.to/api/stats-ingest)
 * - STATS_INGEST_KEY (required)
 */
export async function pushLeavesUpdates(updates) {
  try {
    if (!Array.isArray(updates) || updates.length === 0) return false;
    const url = process.env.HUB_STATS_INGEST_URL || 'https://hub.projectx.to/api/stats-ingest';
    const key = process.env.STATS_INGEST_KEY || process.env.HUB_STATS_INGEST_KEY;
    if (!url || !key) return false;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key
        },
        body: JSON.stringify({ leavesUpdatesNext14: updates }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      return res.ok;
    } catch (err) {
      try { clearTimeout(timeout); } catch {}
      return false;
    }
  } catch {
    return false;
  }
}

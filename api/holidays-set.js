import { sql } from '@vercel/postgres';
import { ensureSchema, touchChange } from './db.js';
import { broadcastChange } from './realtime.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  try {
    await ensureSchema();
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    const { requireAuth } = await import('./auth-helpers.js');
    const authed = requireAuth(req, res, ['HR','MANAGER']); if(!authed) return;
    const { dates } = req.body || {};
    if (!Array.isArray(dates)) return res.status(400).json({ ok: false, error: 'dates array required' });

    // Clear then insert (avoid sql.begin since some environments don't support it)
    await sql`DELETE FROM holidays`;
    for (const d of dates) {
      // Basic ISO date validation guard
      if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
        await sql`INSERT INTO holidays (date) VALUES (${d}) ON CONFLICT (date) DO NOTHING`;
      }
    }
    await touchChange();
    await broadcastChange({ scope: 'holidays' });
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

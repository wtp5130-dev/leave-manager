import { sql } from '@vercel/postgres';
import { ensureSchema, touchChange } from './db';
import { broadcastChange } from './realtime';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  try {
    await ensureSchema();
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    const { dates } = req.body || {};
    if (!Array.isArray(dates)) return res.status(400).json({ ok: false, error: 'dates array required' });

    // Use transaction
    await sql.begin(async (tx) => {
      await tx`DELETE FROM holidays`;
      for (const d of dates) {
        await tx`INSERT INTO holidays (date) VALUES (${d}) ON CONFLICT (date) DO NOTHING`;
      }
    });
    await touchChange();
    await broadcastChange({ scope: 'holidays' });
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

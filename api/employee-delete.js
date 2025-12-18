import { sql } from '@vercel/postgres';
import { ensureSchema, touchChange } from './db.js';
import { broadcastChange } from './realtime.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  try {
    await ensureSchema();
    const { requireAuth } = await import('./auth-helpers.js');
    const authed = requireAuth(req, res, ['HR','MANAGER']); if(!authed) return;
    const id = (req.query?.id||'').toString();
    if (!id) return res.status(400).json({ ok: false, error: 'id required' });
    await sql`DELETE FROM employees WHERE id=${id}`;
    await touchChange();
    await broadcastChange({ scope: 'employee' });
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

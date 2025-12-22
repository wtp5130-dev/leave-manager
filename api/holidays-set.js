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
    const { holidays, dates } = req.body || {};
    
    // Support both old format (dates array) and new format (holidays with names)
    let holidayList = [];
    if (Array.isArray(holidays)) {
      holidayList = holidays;
    } else if (Array.isArray(dates)) {
      holidayList = dates.map(d => ({ date: d, name: '' }));
    } else {
      return res.status(400).json({ ok: false, error: 'holidays or dates array required' });
    }

    // Clear then insert
    await sql`DELETE FROM holidays`;
    for (const h of holidayList) {
      const date = typeof h === 'string' ? h : h.date;
      const name = typeof h === 'string' ? '' : (h.name || '');
      // Basic ISO date validation guard
      if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
        await sql`INSERT INTO holidays (date, name) VALUES (${date}, ${name}) ON CONFLICT (date) DO UPDATE SET name = ${name}`;
      }
    }
    await touchChange();
    await broadcastChange({ scope: 'holidays' });
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

import { sql } from '@vercel/postgres';
import { ensureSchema } from './db';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  try {
    await ensureSchema();
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    const l = req.body || {};
    if (!l.id || !l.employeeId || !l.type) return res.status(400).json({ ok: false, error: 'id, employeeId, type required' });
    await sql`INSERT INTO leaves (id, employee_id, type, status, applied, from_date, to_date, days, reason, approved_by, approved_at, updated_at)
              VALUES (${l.id}, ${l.employeeId}, ${l.type}, ${l.status||'PENDING'}, ${l.applied||null}, ${l.from||null}, ${l.to||null}, ${l.days||0}, ${l.reason||null}, ${l.approvedBy||null}, ${l.approvedAt||null}, now())
              ON CONFLICT (id) DO UPDATE SET employee_id=excluded.employee_id, type=excluded.type, status=excluded.status, applied=excluded.applied, from_date=excluded.from_date, to_date=excluded.to_date, days=excluded.days, reason=excluded.reason, approved_by=excluded.approved_by, approved_at=excluded.approved_at, updated_at=now()`;
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

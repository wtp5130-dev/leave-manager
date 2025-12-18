import { sql } from '@vercel/postgres';
import { ensureSchema, touchChange } from './db.js';
import { broadcastChange } from './realtime.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  try {
    await ensureSchema();
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    const { id, name, jobTitle, department, dateJoined, entitlement } = req.body || {};
    if (!id || !name) return res.status(400).json({ ok: false, error: 'id and name required' });

    await sql`INSERT INTO employees (id, name, job_title, department, date_joined)
              VALUES (${id}, ${name}, ${jobTitle||null}, ${department||null}, ${dateJoined||null})
              ON CONFLICT (id) DO UPDATE SET name=excluded.name, job_title=excluded.job_title, department=excluded.department, date_joined=excluded.date_joined, updated_at=now()`;

    if (entitlement && entitlement.year) {
      await sql`INSERT INTO entitlements (employee_id, year, carry, current)
                VALUES (${id}, ${entitlement.year}, ${entitlement.carry||0}, ${entitlement.current||0})
                ON CONFLICT (employee_id, year) DO UPDATE SET carry=excluded.carry, current=excluded.current`;
    }

    await touchChange();
    await broadcastChange({ scope: 'employee' });
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

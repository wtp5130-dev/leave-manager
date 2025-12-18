import { sql } from '@vercel/postgres';
import { ensureSchema } from './db';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  try {
    await ensureSchema();
    const { rows } = await sql`
      SELECT GREATEST(
        (SELECT COALESCE(MAX(updated_at),'epoch') FROM employees),
        (SELECT COALESCE(MAX(updated_at),'epoch') FROM leaves),
        (SELECT last_change FROM meta WHERE id=1)
      ) AS ts`;
    const ts = rows?.[0]?.ts || new Date(0);
    res.status(200).json({ lastChange: new Date(ts).toISOString() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

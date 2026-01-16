import { sql } from '@vercel/postgres';
import { ensureSchema } from './db.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  try {
    await ensureSchema();
    const { start, end } = nextWindow(14);

    // Fetch approved (or implicit approved) leaves overlapping the next 14 days with employee names
    const { rows } = await sql`
      SELECT e.name AS employee_name, l.from_date, l.to_date
      FROM leaves l
      JOIN employees e ON e.id = l.employee_id
      WHERE (l.status = 'APPROVED' OR l.status IS NULL)
        AND l.to_date >= ${start}
        AND l.from_date <= ${end}
      ORDER BY l.from_date ASC
    `;

    const leaves = rows.map(r => ({
      name: r.employee_name || '',
      start: r.from_date,
      end: r.to_date
    }));

    res.status(200).json({ leaves });
  } catch (e) {
    res.status(200).json({ leaves: [] });
  }
}

function nextWindow(days) {
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() + days);
  return { start: fmtDate(now), end: fmtDate(end) };
}

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

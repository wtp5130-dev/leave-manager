import { sql } from '@vercel/postgres';
import { ensureSchema } from './db.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  const started = Date.now();
  try {
    if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');
    await ensureSchema();

    // Last 14 days of approval/rejection decisions
    const { start, end } = lastWindow(14);

    // Preferred shape: status updates within the last 14 days based on approved_at
    const { rows: updRows } = await sql`
      SELECT e.name AS employee_name, e.email AS employee_email, l.status, l.approved_at
      FROM leaves l
      JOIN employees e ON e.id = l.employee_id
      WHERE (l.status = 'APPROVED' OR l.status = 'REJECTED')
        AND l.approved_at IS NOT NULL
        AND l.approved_at >= ${start}
        AND l.approved_at <= ${end}
      ORDER BY l.approved_at ASC
    `;

    const leavesUpdatesNext14 = updRows.map(r => ({
      date: (r.approved_at || '').slice(0, 10),
      name: r.employee_name || '',
      email: r.employee_email || '',
      status: String(r.status || '').toLowerCase() === 'approved' ? 'approved' : 'rejected'
    }));

    // Also accepted shape (optional): per-leave items overlapping the next 14 days with explicit status
    const { rows: leaveRows } = await sql`
      SELECT e.name AS employee_name, e.email AS employee_email, l.from_date, l.to_date, l.status
      FROM leaves l
      JOIN employees e ON e.id = l.employee_id
      WHERE l.to_date >= ${fmtDate(new Date())}
        AND l.from_date <= ${fmtDate(offsetDays(new Date(), 14))}
        AND (l.status = 'APPROVED' OR l.status = 'REJECTED')
      ORDER BY l.from_date ASC
    `;

    const leaves = leaveRows.map(r => ({
      name: r.employee_name || '',
      email: r.employee_email || '',
      start: r.from_date,
      end: r.to_date,
      status: String(r.status || '').toLowerCase() === 'approved' ? 'approved' : 'rejected'
    }));

    // Optional grouped shape if consumers prefer grouped away days (approved only) for the next 14 days
    const grouped = groupApprovedByDate(leaveRows.filter(r => String(r.status).toUpperCase() === 'APPROVED'), fmtDate(new Date()), fmtDate(offsetDays(new Date(), 14)));

    // Ensure < 7s response; include timing header for observability
    res.setHeader('X-Response-Time', `${Date.now() - started}ms`);
    return res.status(200).json({ leavesUpdatesNext14, leaves, leavesNext14: grouped });
  } catch (e) {
    // Be resilient and still return a valid, empty structure
    res.setHeader('X-Response-Error', '1');
    return res.status(200).json({ leavesUpdatesNext14: [], leaves: [], leavesNext14: [] });
  }
}

function lastWindow(days) {
  const end = new Date();
  const start = offsetDays(end, -days);
  return { start: fmtDate(start), end: fmtDate(end) };
}

function fmtDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function offsetDays(date, delta) {
  const d = new Date(date);
  d.setDate(d.getDate() + delta);
  return d;
}

function groupApprovedByDate(rows, start, end) {
  // Build a map of date -> Set(names)
  const byDate = new Map();
  for (const r of rows) {
    const from = new Date(r.from_date);
    const to = new Date(r.to_date);
    const winStart = new Date(start);
    const winEnd = new Date(end);
    const a = from < winStart ? winStart : from;
    const b = to > winEnd ? winEnd : to;
    for (let d = new Date(a); d <= b; d.setDate(d.getDate() + 1)) {
      const key = fmtDate(d);
      if (!byDate.has(key)) byDate.set(key, new Set());
      byDate.get(key).add(r.employee_name || '');
    }
  }
  return Array.from(byDate.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, namesSet]) => ({ date, names: Array.from(namesSet) }));
}

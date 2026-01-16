import { sql } from '@vercel/postgres';
import { ensureSchema } from './db.js';

export const config = { runtime: 'nodejs' };

// Simple in-memory cache (per lambda instance)
let CACHE = { ts: 0, data: null };
const TTL_MS = 10 * 60 * 1000; // 10 minutes

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://local');
    const forceRefresh = url.searchParams.get('refresh') === '1';

    const pendingApprovals = await getPendingApprovalsCount();
    const leavesNext14 = await getUpcomingLeaves({ forceRefresh });

    res.status(200).json({ pendingApprovals, leavesNext14 });
  } catch (e) {
    // Be resilient: at minimum return pending approvals, omit leaves list on error
    try {
      const pendingApprovals = await getPendingApprovalsCount().catch(() => 0);
      res.status(200).json({ pendingApprovals, leavesNext14: [] });
    } catch {
      res.status(200).json({ pendingApprovals: 0, leavesNext14: [] });
    }
  }
}

async function getPendingApprovalsCount() {
  await ensureSchema();
  const { rows } = await sql`SELECT COUNT(*)::int AS c FROM leaves WHERE status = 'PENDING'`;
  return Number(rows?.[0]?.c || 0);
}

async function getUpcomingLeaves({ forceRefresh = false } = {}) {
  const UPCOMING_URL = process.env.UPCOMING_LEAVES_URL;
  if (!UPCOMING_URL) return buildEmptyNext14();

  if (!forceRefresh && CACHE.data && Date.now() - CACHE.ts < TTL_MS) {
    return CACHE.data;
  }

  let headers = {};
  const rawHeaders = process.env.UPCOMING_LEAVES_HEADERS;
  if (rawHeaders) {
    try {
      const parsed = JSON.parse(rawHeaders);
      if (Array.isArray(parsed)) {
        // Expect array of { name, value }
        parsed.forEach(h => {
          if (h && h.name && h.value) headers[h.name] = String(h.value);
        });
      } else if (parsed && typeof parsed === 'object') {
        headers = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, String(v)]));
      }
    } catch {
      // ignore header parse errors
    }
  }

  let payload;
  try {
    const r = await fetch(UPCOMING_URL, { headers });
    if (!r.ok) throw new Error(`Fetch failed ${r.status}`);
    payload = await r.json();
  } catch (e) {
    // On fetch error, return empty schedule but do not throw
    const data = buildEmptyNext14();
    CACHE = { ts: Date.now(), data };
    return data;
  }

  // Accepts either an array or an object with a 'leaves' array
  const leavesArr = Array.isArray(payload) ? payload : (Array.isArray(payload?.leaves) ? payload.leaves : []);

  const windowDates = buildWindowDates(14); // array of YYYY-MM-DD
  const byDate = new Map(windowDates.map(d => [d, new Set()]));

  for (const item of leavesArr) {
    const name = extractName(item);
    if (!name) continue;

    const { start, end, single } = extractDates(item);
    if (single) {
      // single date
      if (byDate.has(single)) byDate.get(single).add(name);
      continue;
    }
    if (start && end) {
      for (const d of expandRange(start, end)) {
        if (byDate.has(d)) byDate.get(d).add(name);
      }
    }
  }

  const data = windowDates.map(d => ({ date: d, names: Array.from(byDate.get(d) || []) }));
  CACHE = { ts: Date.now(), data };
  return data;
}

function buildWindowDates(days) {
  const today = new Date();
  const list = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    list.push(fmtDate(d));
  }
  return list;
}

function buildEmptyNext14() {
  return buildWindowDates(14).map(d => ({ date: d, names: [] }));
}

function fmtDate(d) {
  // Format as YYYY-MM-DD without timezone drift
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function toDateOnlyString(s) {
  if (!s) return null;
  try {
    // If already YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    if (isNaN(d)) return null;
    return fmtDate(d);
  } catch { return null; }
}

function expandRange(startStr, endStr) {
  const out = [];
  const s = new Date(startStr);
  const e = new Date(endStr);
  if (isNaN(s) || isNaN(e)) return out;
  const a = s <= e ? s : e;
  const b = s <= e ? e : s;
  const cur = new Date(a);
  while (cur <= b) {
    out.push(fmtDate(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function extractDates(item) {
  // Try common shapes: { date }, { start, end }, { from, to }, { startDate, endDate }
  const val = (k) => item && (item[k] ?? item?.[k] ?? null);

  // Single date
  const singleCandidates = ['date', 'day', 'day_date'];
  for (const k of singleCandidates) {
    const v = val(k);
    const s = typeof v === 'string' ? v : (typeof v === 'object' && v?.date ? v.date : null);
    const d = toDateOnlyString(s);
    if (d) return { start: null, end: null, single: d };
  }

  // Ranges
  const startKeys = ['start', 'from', 'startDate', 'start_date', 'begin', 'beginDate'];
  const endKeys = ['end', 'to', 'endDate', 'end_date', 'finish', 'finishDate'];
  let start = null, end = null;
  for (const k of startKeys) {
    const s = val(k);
    const str = typeof s === 'string' ? s : (typeof s === 'object' && s?.date ? s.date : null);
    const d = toDateOnlyString(str);
    if (d) { start = d; break; }
  }
  for (const k of endKeys) {
    const s = val(k);
    const str = typeof s === 'string' ? s : (typeof s === 'object' && s?.date ? s.date : null);
    const d = toDateOnlyString(str);
    if (d) { end = d; break; }
  }
  return { start, end, single: null };
}

function extractName(item) {
  // Try various shapes: name, employee, employee.name, user.name, user, employeeName
  if (!item || typeof item !== 'object') return null;
  const direct = item.name || item.employee || item.employeeName || item.employee_name || item.user || item.userName || item.user_name;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  if (item.employee && typeof item.employee === 'object') {
    const n = item.employee.name || item.employee.fullName || item.employee.full_name;
    if (typeof n === 'string' && n.trim()) return n.trim();
  }
  if (item.user && typeof item.user === 'object') {
    const n = item.user.name || item.user.fullName || item.user.full_name;
    if (typeof n === 'string' && n.trim()) return n.trim();
  }
  return null;
}

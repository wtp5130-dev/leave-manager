import { sql } from '@vercel/postgres';

export const config = { runtime: 'nodejs' };

export async function ensureSchema() {
  // Create tables if not exist
  await sql`CREATE TABLE IF NOT EXISTS employees (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    job_title TEXT,
    department TEXT,
    date_joined TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  )`;

  await sql`CREATE TABLE IF NOT EXISTS entitlements (
    employee_id TEXT REFERENCES employees(id) ON DELETE CASCADE,
    year INT NOT NULL,
    carry NUMERIC DEFAULT 0,
    current NUMERIC DEFAULT 0,
    PRIMARY KEY (employee_id, year)
  )`;

  await sql`CREATE TABLE IF NOT EXISTS leaves (
    id TEXT PRIMARY KEY,
    employee_id TEXT REFERENCES employees(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    status TEXT,
    applied TEXT,
    from_date TEXT,
    to_date TEXT,
    days NUMERIC,
    reason TEXT,
    approved_by TEXT,
    approved_at TEXT,
    created_by TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  )`;

  await sql`CREATE TABLE IF NOT EXISTS holidays (
    date TEXT PRIMARY KEY
  )`;

  await sql`CREATE TABLE IF NOT EXISTS meta (
    id INT PRIMARY KEY DEFAULT 1,
    last_change TIMESTAMPTZ DEFAULT now()
  )`;
  await sql`INSERT INTO meta (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;

  await sql`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, -- google sub
    email TEXT UNIQUE,
    name TEXT,
    picture TEXT,
    role TEXT DEFAULT 'EMPLOYEE',
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
  )`;
}

export async function getAllData() {
  await ensureSchema();
  const { rows: empRows } = await sql`SELECT * FROM employees ORDER BY name ASC`;
  const { rows: entRows } = await sql`SELECT * FROM entitlements`;
  const { rows: leaveRows } = await sql`SELECT * FROM leaves ORDER BY from_date ASC`;
  const { rows: holRows } = await sql`SELECT * FROM holidays ORDER BY date ASC`;

  const entByEmp = {};
  for (const r of entRows) {
    entByEmp[r.employee_id] ||= {};
    entByEmp[r.employee_id][r.year] = { carry: Number(r.carry || 0), current: Number(r.current || 0) };
  }
  const employees = empRows.map(e => ({
    id: e.id,
    name: e.name,
    jobTitle: e.job_title,
    department: e.department,
    dateJoined: e.date_joined,
    entitlements: entByEmp[e.id] || {}
  }));
  const leaves = leaveRows.map(l => ({
    id: l.id,
    employeeId: l.employee_id,
    type: l.type,
    status: l.status,
    applied: l.applied,
    from: l.from_date,
    to: l.to_date,
    days: Number(l.days || 0),
    reason: l.reason,
    approvedBy: l.approved_by,
    approvedAt: l.approved_at,
    createdBy: l.created_by
  }));
  const holidays = holRows.map(h => h.date);
  return { employees, leaves, holidays };
}

export async function touchChange() {
  await sql`UPDATE meta SET last_change = now() WHERE id = 1`;
}

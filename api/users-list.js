import { sql } from '@vercel/postgres';
import { requireAuth } from './auth-helpers.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  await requireAuth(req, res, ['HR', 'MANAGER']);
  if (res.headersSent) return;

  try {
    const { rows } = await sql`
      SELECT id, email, name, picture, role, created_at 
      FROM users 
      ORDER BY created_at DESC
    `;
    res.status(200).json({ ok: true, users: rows });
  } catch (e) {
    console.error('users-list error:', e);
    res.status(500).json({ ok: false, error: 'Failed to fetch users' });
  }
}

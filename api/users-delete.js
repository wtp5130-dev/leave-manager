import { sql } from '@vercel/postgres';
import { requireAuth } from './auth-helpers.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  await requireAuth(req, res, ['HR', 'MANAGER']);
  if (res.headersSent) return;

  const { id } = req.query;

  if (!id) {
    return res.status(400).json({ ok: false, error: 'User ID required' });
  }

  try {
    // Check if user exists
    const existing = await sql`SELECT id FROM users WHERE id = ${id}`;
    if (existing.rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'User not found' });
    }

    // Delete user
    await sql`DELETE FROM users WHERE id = ${id}`;

    res.status(200).json({ ok: true, message: 'User deleted' });
  } catch (e) {
    console.error('users-delete error:', e);
    res.status(500).json({ ok: false, error: 'Failed to delete user' });
  }
}

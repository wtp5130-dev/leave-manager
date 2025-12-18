import { OAuth2Client } from 'google-auth-library';
import { sql } from '@vercel/postgres';
import { ensureSchema } from './db.js';
import { setSessionCookie } from './auth-helpers.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res){
  try{
    if(req.method !== 'POST') return res.status(405).send('Method Not Allowed');
    await ensureSchema();
    const { idToken } = req.body || {};
    if(!idToken) return res.status(400).json({ ok:false, error:'idToken required' });

    const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
    const ticket = await client.verifyIdToken({ idToken, audience: process.env.GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const sub = payload.sub;
    const email = payload.email;
    const name = payload.name || '';
    const picture = payload.picture || '';

    await sql`INSERT INTO users (id, email, name, picture)
              VALUES (${sub}, ${email}, ${name}, ${picture})
              ON CONFLICT (id) DO UPDATE SET email=excluded.email, name=excluded.name, picture=excluded.picture, updated_at=now()`;

    const { rows } = await sql`SELECT id, email, name, picture, role FROM users WHERE id=${sub}`;
    const user = rows[0];
    setSessionCookie(res, { id:user.id, email:user.email, name:user.name, picture:user.picture, role:user.role });
    res.status(200).json({ ok:true, user });
  }catch(err){
    res.status(500).json({ ok:false, error: err.message });
  }
}

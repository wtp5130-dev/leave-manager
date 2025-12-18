import { clearSessionCookie } from './auth-helpers.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res){
  clearSessionCookie(res);
  res.status(200).json({ ok:true });
}

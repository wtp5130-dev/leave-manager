import { getUserFromRequest } from './auth-helpers.js';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res){
  const user = getUserFromRequest(req);
  if(!user) return res.status(401).json({ ok:false });
  res.status(200).json({ ok:true, user });
}

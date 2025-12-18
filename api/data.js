import { getAllData } from './db';

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  try {
    const data = await getAllData();
    res.status(200).json(data);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  const key = process.env.PUSHER_KEY || '';
  const cluster = process.env.PUSHER_CLUSTER || '';
  res.status(200).json({ key, cluster });
}

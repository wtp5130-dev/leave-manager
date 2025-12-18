export const config = { runtime: 'nodejs' };

export default async function handler(req, res){
  const clientId = process.env.GOOGLE_CLIENT_ID || '';
  res.status(200).json({ clientId });
}

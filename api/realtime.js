import Pusher from 'pusher';

// Node runtime
export const config = { runtime: 'nodejs' };

let pusher = null;
function getPusher() {
  if (pusher) return pusher;
  const { PUSHER_APP_ID, PUSHER_KEY, PUSHER_SECRET, PUSHER_CLUSTER } = process.env;
  if (!PUSHER_APP_ID || !PUSHER_KEY || !PUSHER_SECRET || !PUSHER_CLUSTER) return null;
  pusher = new Pusher({
    appId: PUSHER_APP_ID,
    key: PUSHER_KEY,
    secret: PUSHER_SECRET,
    cluster: PUSHER_CLUSTER,
    useTLS: true,
  });
  return pusher;
}

export async function broadcastChange(payload={}) {
  const client = getPusher();
  if (!client) return; // silently no-op if not configured
  try {
    await client.trigger('leave-manager', 'changed', { t: Date.now(), ...payload });
  } catch (e) {
    // ignore
  }
}

export default async function handler(req, res) {
  // Simple health-check endpoint
  const has = !!getPusher();
  res.status(200).json({ ok: true, configured: has });
}

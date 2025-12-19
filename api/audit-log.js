import { sql } from '@vercel/postgres';

export const config = { runtime: 'nodejs' };

/**
 * Log an audit trail entry
 * @param {string} userId - The ID of the user performing the action
 * @param {string} userEmail - The email of the user
 * @param {string} action - Action type (CREATE, UPDATE, DELETE, APPROVE, REJECT, etc.)
 * @param {string} entityType - Type of entity (LEAVE, EMPLOYEE, USER, ENTITLEMENT, etc.)
 * @param {string} entityId - ID of the entity being acted upon
 * @param {string} entityName - Human-readable name of the entity
 * @param {any} oldValue - Previous value (for updates/deletes)
 * @param {any} newValue - New value (for creates/updates)
 * @param {string} details - Additional context or details
 */
export async function logAudit(userId, userEmail, action, entityType, entityId, entityName, oldValue = null, newValue = null, details = null) {
  try {
    const oldValueStr = oldValue ? JSON.stringify(oldValue) : null;
    const newValueStr = newValue ? JSON.stringify(newValue) : null;
    
    await sql`
      INSERT INTO audit_logs (user_id, user_email, action, entity_type, entity_id, entity_name, old_value, new_value, details)
      VALUES (${userId}, ${userEmail}, ${action}, ${entityType}, ${entityId}, ${entityName}, ${oldValueStr}, ${newValueStr}, ${details})
    `;
  } catch (err) {
    console.error('Audit log error:', err.message);
    // Don't throw - audit logging should not break the main operation
  }
}

export default async function handler(req, res) {
  try {
    const { requireAuth } = await import('./auth-helpers.js');
    const user = requireAuth(req, res);
    if (!user) return;

    if (req.method === 'GET') {
      const limit = parseInt(req.query?.limit || '100');
      const offset = parseInt(req.query?.offset || '0');
      
      const { getAuditLogs } = await import('./db.js');
      const logs = await getAuditLogs(limit, offset);
      
      return res.status(200).json({ ok: true, logs });
    }

    res.status(405).json({ ok: false, error: 'Method Not Allowed' });
  } catch (err) {
    console.error('audit-log endpoint error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
}

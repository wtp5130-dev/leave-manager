export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  try {
    const pendingApprovals = await getPendingApprovalsCount();
    res.status(200).json({ pendingApprovals });
  } catch (e) {
    // Be resilient: return 0 if anything goes wrong
    res.status(200).json({ pendingApprovals: 0 });
  }
}

// TODO: replace with real data source
async function getPendingApprovalsCount() {
  // Example: query DB or internal API
  // return await prisma.leaveRequest.count({ where: { status: 'PENDING' } });
  return Number(process.env.PENDING_APPROVALS_COUNT || 0);
}

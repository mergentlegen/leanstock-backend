const { prisma } = require("../config/database");

async function listAuditLogs(req, res) {
  const limit = Math.min(Number(req.query.limit || 50), 100);
  const logs = await prisma.auditLog.findMany({
    where: { tenantId: req.user.tenantId },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    ...(req.query.cursor ? { cursor: { id: req.query.cursor }, skip: 1 } : {}),
  });
  const hasNextPage = logs.length > limit;
  const data = hasNextPage ? logs.slice(0, limit) : logs;
  res.json({
    data,
    pageInfo: {
      hasNextPage,
      nextCursor: hasNextPage ? data[data.length - 1].id : null,
    },
  });
}

async function getJobQueues(req, res) {
  const { emailQueue, maintenanceQueue, getQueueSummary } = require("../config/queues");
  const [email, maintenance] = await Promise.all([
    getQueueSummary(emailQueue),
    getQueueSummary(maintenanceQueue),
  ]);
  res.json({ email, maintenance });
}

module.exports = { listAuditLogs, getJobQueues };

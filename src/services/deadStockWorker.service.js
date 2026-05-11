const cron = require("node-cron");
const { env } = require("../config/env");
const { prisma } = require("../config/database");
const { maintenanceQueue } = require("../config/queues");

let scheduledTask = null;

function startDeadStockWorker() {
  if (!env.ENABLE_DEAD_STOCK_WORKER || process.env.NODE_ENV === "test") {
    return null;
  }

  scheduledTask = cron.schedule(env.DEAD_STOCK_DECAY_CRON, async () => {
    const tenants = await prisma.tenant.findMany({ select: { id: true } });
    for (const tenant of tenants) {
      await maintenanceQueue.add("dead-stock-decay", {
        tenantId: tenant.id,
        now: new Date().toISOString(),
      }, {
        attempts: 3,
        backoff: {
          type: "exponential",
          delay: 10000,
        },
        removeOnComplete: 100,
        removeOnFail: 100,
      });
    }
  });

  console.log(`Dead stock worker scheduled with cron: ${env.DEAD_STOCK_DECAY_CRON}`);
  return scheduledTask;
}

function stopDeadStockWorker() {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
}

module.exports = { startDeadStockWorker, stopDeadStockWorker };

const { Worker } = require("bullmq");
const { createQueueConnection } = require("../config/queues");
const { sendEmailNow } = require("./email.service");
const { applyDeadStockDecayForTenant } = require("./inventory.service");

const workers = [];

function startWorkers() {
  const emailWorker = new Worker("email", async (job) => {
    return sendEmailNow(job.data);
  }, { connection: createQueueConnection(), concurrency: 5 });

  const maintenanceWorker = new Worker("maintenance", async (job) => {
    if (job.name === "dead-stock-decay") {
      return applyDeadStockDecayForTenant({
        tenantId: job.data.tenantId,
        actorUserId: null,
        now: job.data.now ? new Date(job.data.now) : new Date(),
      });
    }
    throw new Error(`Unknown maintenance job: ${job.name}`);
  }, { connection: createQueueConnection(), concurrency: 2 });

  workers.push(emailWorker, maintenanceWorker);
  console.log("BullMQ workers started: email, maintenance");
}

async function stopWorkers() {
  await Promise.all(workers.map((worker) => worker.close()));
  workers.length = 0;
}

module.exports = { startWorkers, stopWorkers };

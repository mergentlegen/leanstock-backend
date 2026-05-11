const { Queue, QueueEvents } = require("bullmq");
const IORedis = require("ioredis");
const { env } = require("./env");

function createQueueConnection() {
  return new IORedis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
  });
}

const emailQueue = new Queue("email", { connection: createQueueConnection() });
const maintenanceQueue = new Queue("maintenance", { connection: createQueueConnection() });
const emailQueueEvents = new QueueEvents("email", { connection: createQueueConnection() });
const maintenanceQueueEvents = new QueueEvents("maintenance", { connection: createQueueConnection() });

async function closeQueues() {
  await Promise.all([
    emailQueue.close(),
    maintenanceQueue.close(),
    emailQueueEvents.close(),
    maintenanceQueueEvents.close(),
  ]);
}

async function getQueueSummary(queue) {
  const [counts, failed, completed, waiting, active] = await Promise.all([
    queue.getJobCounts("waiting", "active", "completed", "failed", "delayed"),
    queue.getFailed(0, 10),
    queue.getCompleted(0, 10),
    queue.getWaiting(0, 10),
    queue.getActive(0, 10),
  ]);

  return {
    counts,
    failed: failed.map(serializeJob),
    completed: completed.map(serializeJob),
    waiting: waiting.map(serializeJob),
    active: active.map(serializeJob),
  };
}

function serializeJob(job) {
  return {
    id: job.id,
    name: job.name,
    attemptsMade: job.attemptsMade,
    failedReason: job.failedReason,
    timestamp: job.timestamp,
    processedOn: job.processedOn,
    finishedOn: job.finishedOn,
    data: job.data,
  };
}

module.exports = {
  emailQueue,
  maintenanceQueue,
  closeQueues,
  createQueueConnection,
  getQueueSummary,
};

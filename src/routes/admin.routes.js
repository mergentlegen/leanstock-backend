const express = require("express");
const { requireAuth, requireRoles } = require("../middleware/auth");
const { asyncHandler } = require("../utils/asyncHandler");
const { listAuditLogs, getJobQueues } = require("../controllers/adminController");

const router = express.Router();

router.get("/audit-logs", requireAuth, requireRoles("ADMIN"), asyncHandler(listAuditLogs));
router.get("/jobs", requireAuth, requireRoles("ADMIN"), asyncHandler(getJobQueues));

module.exports = router;

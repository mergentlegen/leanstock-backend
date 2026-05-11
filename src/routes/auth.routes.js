const express = require("express");
const { validate } = require("../middleware/validate");
const { authRateLimit } = require("../middleware/rateLimit");
const { requireAuth } = require("../middleware/auth");
const { asyncHandler } = require("../utils/asyncHandler");
const {
  registerSchema,
  loginSchema,
  refreshSchema,
  logoutSchema,
  verifyEmailSchema,
  passwordResetRequestSchema,
  passwordResetConfirmSchema,
} = require("../schemas/auth.schema");
const controller = require("../controllers/authController");

const router = express.Router();

router.post("/register", authRateLimit, validate(registerSchema), asyncHandler(controller.register));
router.post("/login", authRateLimit, validate(loginSchema), asyncHandler(controller.login));
router.post("/refresh", validate(refreshSchema), asyncHandler(controller.refresh));
router.post("/logout", requireAuth, validate(logoutSchema), asyncHandler(controller.logout));
router.get("/me", requireAuth, asyncHandler(controller.me));
router.get("/verify-email", validate(verifyEmailSchema), asyncHandler(controller.verifyEmailHandler));
router.post("/verify-email", validate(verifyEmailSchema), asyncHandler(controller.verifyEmailHandler));
router.post("/password-reset/request", authRateLimit, validate(passwordResetRequestSchema), asyncHandler(controller.requestPasswordResetHandler));
router.post("/password-reset/confirm", authRateLimit, validate(passwordResetConfirmSchema), asyncHandler(controller.confirmPasswordResetHandler));

module.exports = router;

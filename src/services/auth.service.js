const bcrypt = require("bcryptjs");
const { Prisma } = require("@prisma/client");
const { env } = require("../config/env");
const { prisma } = require("../config/database");
const { slugify } = require("../utils/slug");
const { badRequest, conflict, forbidden, unauthorized } = require("../utils/errors");
const { signAccessToken, issueRefreshToken, revokeRefreshToken, rotateRefreshToken } = require("./token.service");
const { issueEmailToken, consumeEmailToken } = require("./emailToken.service");
const { queueEmail } = require("./email.service");
const { writeAudit } = require("./audit.service");

async function registerUser(input, ipAddress) {
  const existing = await prisma.user.findFirst({
    where: {
      OR: [{ email: input.email }, { username: input.username }],
    },
  });

  if (existing) {
    throw conflict("Email or username is already registered");
  }

  const passwordHash = await bcrypt.hash(input.password, 12);
  const tenantSlugBase = slugify(input.tenantName);
  const tenantSlug = `${tenantSlugBase}-${Date.now().toString(36)}`;

  const result = await prisma.$transaction(async (tx) => {
    const tenant = await tx.tenant.create({
      data: {
        name: input.tenantName,
        slug: tenantSlug,
      },
    });

    const user = await tx.user.create({
      data: {
        tenantId: tenant.id,
        email: input.email,
        username: input.username,
        passwordHash,
        role: input.role ?? "MERCHANT",
        emailVerifiedAt: null,
      },
    });

    await writeAudit({
      tx,
      tenantId: tenant.id,
      actorUserId: user.id,
      action: "USER_REGISTERED",
      entityType: "User",
      entityId: user.id,
      metadata: { email: user.email, role: user.role },
      ipAddress,
    });

    const verification = await issueEmailToken({
      userId: user.id,
      purpose: "EMAIL_VERIFICATION",
      ttlMinutes: env.EMAIL_VERIFICATION_TTL_MINUTES,
      tx,
    });

    return {
      user: publicUser(user),
      tenant,
      verification,
    };
  });

  const verifyUrl = `${env.APP_BASE_URL}/auth/verify-email?token=${encodeURIComponent(result.verification.token)}`;
  await queueEmail({
    to: result.user.email,
    subject: "Verify your LeanStock account",
    text: `Welcome to LeanStock. Verify your account here: ${verifyUrl}`,
    html: `<p>Welcome to LeanStock.</p><p><a href="${verifyUrl}">Verify your account</a></p>`,
    eventType: "EMAIL_VERIFICATION",
    metadata: { userId: result.user.id, tenantId: result.tenant.id },
  });

  return {
    user: result.user,
    tenant: result.tenant,
    verificationRequired: true,
    verificationTokenExpiresAt: result.verification.expiresAt,
  };
}

async function loginUser(input, ipAddress) {
  const user = await prisma.user.findUnique({ where: { email: input.email } });

  if (!user) {
    throw unauthorized("Invalid email or password");
  }

  const ok = await bcrypt.compare(input.password, user.passwordHash);
  if (!ok) {
    throw unauthorized("Invalid email or password");
  }
  if (!user.isActive) {
    throw forbidden("User account is disabled");
  }
  if (!user.emailVerifiedAt) {
    throw forbidden("Email verification is required before login");
  }

  const refresh = await issueRefreshToken(user.id);
  await writeAudit({
    tenantId: user.tenantId,
    actorUserId: user.id,
    action: "LOGIN",
    entityType: "User",
    entityId: user.id,
    ipAddress,
  });

  return {
    user: publicUser(user),
    accessToken: signAccessToken(user),
    refreshToken: refresh.refreshToken,
    refreshTokenExpiresAt: refresh.expiresAt,
  };
}

async function refreshAccessToken(rawRefreshToken, ipAddress) {
  const rotated = await prisma.$transaction(async (tx) => rotateRefreshToken(rawRefreshToken, tx));
  if (!rotated) {
    throw unauthorized("Refresh token is invalid, expired, or revoked");
  }

  await writeAudit({
    tenantId: rotated.existing.user.tenantId,
    actorUserId: rotated.existing.user.id,
    action: "TOKEN_REFRESH",
    entityType: "RefreshToken",
    entityId: rotated.existing.id,
    ipAddress,
  });

  return {
    accessToken: signAccessToken(rotated.existing.user),
    refreshToken: rotated.next.refreshToken,
    refreshTokenExpiresAt: rotated.next.expiresAt,
    expiresIn: Number(process.env.ACCESS_TOKEN_TTL_SECONDS || 900),
  };
}

async function logoutUser(rawRefreshToken, actorUserId, tenantId, ipAddress) {
  const result = await revokeRefreshToken(rawRefreshToken);
  await writeAudit({
    tenantId,
    actorUserId,
    action: "LOGOUT",
    entityType: "RefreshToken",
    metadata: { revoked: result.count > 0 },
    ipAddress,
  });
  return { revoked: result.count > 0 };
}

async function verifyEmail(rawToken, ipAddress) {
  const consumed = await prisma.$transaction(async (tx) => {
    const token = await consumeEmailToken({ token: rawToken, purpose: "EMAIL_VERIFICATION", tx });
    if (!token) {
      return null;
    }

    const user = await tx.user.update({
      where: { id: token.userId },
      data: { emailVerifiedAt: new Date() },
    });

    await writeAudit({
      tx,
      tenantId: user.tenantId,
      actorUserId: user.id,
      action: "EMAIL_VERIFIED",
      entityType: "User",
      entityId: user.id,
      ipAddress,
    });

    return user;
  });

  if (!consumed) {
    throw badRequest("Verification token is invalid or expired");
  }

  await queueEmail({
    to: consumed.email,
    subject: "LeanStock account verified",
    text: "Your LeanStock account is verified and ready to use.",
    html: "<p>Your LeanStock account is verified and ready to use.</p>",
    eventType: "ACCOUNT_VERIFIED",
    metadata: { userId: consumed.id, tenantId: consumed.tenantId },
  });

  return { user: publicUser(consumed), verified: true };
}

async function requestPasswordReset(email, ipAddress) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return { accepted: true };
  }

  const reset = await issueEmailToken({
    userId: user.id,
    purpose: "PASSWORD_RESET",
    ttlMinutes: env.PASSWORD_RESET_TTL_MINUTES,
  });
  const resetUrl = `${env.APP_BASE_URL}/reset-password?token=${encodeURIComponent(reset.token)}`;

  await writeAudit({
    tenantId: user.tenantId,
    actorUserId: user.id,
    action: "PASSWORD_RESET_REQUESTED",
    entityType: "User",
    entityId: user.id,
    ipAddress,
  });

  await queueEmail({
    to: user.email,
    subject: "Reset your LeanStock password",
    text: `Reset your password here: ${resetUrl}`,
    html: `<p>Reset your password:</p><p><a href="${resetUrl}">Reset password</a></p>`,
    eventType: "PASSWORD_RESET",
    metadata: { userId: user.id, tenantId: user.tenantId },
  });

  return { accepted: true };
}

async function confirmPasswordReset({ token, newPassword }, ipAddress) {
  const consumed = await prisma.$transaction(async (tx) => {
    const row = await consumeEmailToken({ token, purpose: "PASSWORD_RESET", tx });
    if (!row) {
      return null;
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    const user = await tx.user.update({
      where: { id: row.userId },
      data: { passwordHash },
    });
    await tx.refreshToken.updateMany({
      where: { userId: row.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    await writeAudit({
      tx,
      tenantId: user.tenantId,
      actorUserId: user.id,
      action: "PASSWORD_RESET_COMPLETED",
      entityType: "User",
      entityId: user.id,
      ipAddress,
    });
    return user;
  });

  if (!consumed) {
    throw badRequest("Password reset token is invalid or expired");
  }

  await queueEmail({
    to: consumed.email,
    subject: "LeanStock password changed",
    text: "Your LeanStock password was changed. If this was not you, contact an administrator immediately.",
    html: "<p>Your LeanStock password was changed.</p>",
    eventType: "PASSWORD_RESET_COMPLETED",
    metadata: { userId: consumed.id, tenantId: consumed.tenantId },
  });

  return { reset: true };
}

function publicUser(user) {
  return {
    id: user.id,
    tenantId: user.tenantId,
    email: user.email,
    username: user.username,
    role: user.role,
    emailVerifiedAt: user.emailVerifiedAt,
    isActive: user.isActive,
    createdAt: user.createdAt,
  };
}

function mapPrismaError(error) {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    return conflict("Unique value already exists", error.meta);
  }
  return error;
}

module.exports = {
  registerUser,
  loginUser,
  refreshAccessToken,
  logoutUser,
  verifyEmail,
  requestPasswordReset,
  confirmPasswordReset,
  publicUser,
  mapPrismaError,
};

const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { env } = require("../config/env");
const { prisma } = require("../config/database");

function signAccessToken(user) {
  return jwt.sign(
    {
      sub: user.id,
      tenantId: user.tenantId,
      role: user.role,
      type: "access",
    },
    env.JWT_ACCESS_SECRET,
    { expiresIn: env.ACCESS_TOKEN_TTL_SECONDS },
  );
}

function hashRefreshToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function issueRefreshToken(userId, tx = prisma) {
  const rawToken = crypto.randomBytes(64).toString("base64url");
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
  await tx.refreshToken.create({
    data: {
      userId,
      tokenHash: hashRefreshToken(rawToken),
      expiresAt,
    },
  });
  return { refreshToken: rawToken, expiresAt };
}

function verifyAccessToken(token) {
  return jwt.verify(token, env.JWT_ACCESS_SECRET);
}

async function revokeRefreshToken(rawToken, tx = prisma) {
  const tokenHash = hashRefreshToken(rawToken);
  return tx.refreshToken.updateMany({
    where: {
      tokenHash,
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
    },
  });
}

async function rotateRefreshToken(rawToken, tx = prisma) {
  const existing = await findValidRefreshToken(rawToken, tx);
  if (!existing) {
    return null;
  }

  await tx.refreshToken.update({
    where: { id: existing.id },
    data: { revokedAt: new Date() },
  });
  const next = await issueRefreshToken(existing.user.id, tx);
  return { existing, next };
}

async function findValidRefreshToken(rawToken, tx = prisma) {
  const tokenHash = hashRefreshToken(rawToken);
  return tx.refreshToken.findFirst({
    where: {
      tokenHash,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    include: {
      user: true,
    },
  });
}

module.exports = {
  signAccessToken,
  issueRefreshToken,
  verifyAccessToken,
  revokeRefreshToken,
  findValidRefreshToken,
  rotateRefreshToken,
  hashRefreshToken,
};

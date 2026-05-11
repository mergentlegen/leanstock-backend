const crypto = require("crypto");
const { prisma } = require("../config/database");

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function issueEmailToken({ userId, purpose, ttlMinutes, tx = prisma }) {
  const rawToken = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

  await tx.emailToken.create({
    data: {
      userId,
      tokenHash: hashToken(rawToken),
      purpose,
      expiresAt,
    },
  });

  return { token: rawToken, expiresAt };
}

async function consumeEmailToken({ token, purpose, tx = prisma }) {
  const row = await tx.emailToken.findFirst({
    where: {
      tokenHash: hashToken(token),
      purpose,
      consumedAt: null,
      expiresAt: { gt: new Date() },
    },
    include: { user: true },
  });

  if (!row) {
    return null;
  }

  await tx.emailToken.update({
    where: { id: row.id },
    data: { consumedAt: new Date() },
  });

  return row;
}

module.exports = { issueEmailToken, consumeEmailToken, hashToken };

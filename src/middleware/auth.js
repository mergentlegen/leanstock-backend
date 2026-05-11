const { prisma } = require("../config/database");
const { verifyAccessToken } = require("../services/token.service");
const { unauthorized, forbidden } = require("../utils/errors");

async function requireAuth(req, _res, next) {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      throw unauthorized();
    }

    const token = header.slice("Bearer ".length);
    const payload = verifyAccessToken(token);
    if (payload.type !== "access") {
      throw unauthorized("Invalid token type");
    }

    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        tenantId: true,
        email: true,
        username: true,
        role: true,
        emailVerifiedAt: true,
        isActive: true,
      },
    });

    if (!user) {
      throw unauthorized("User no longer exists");
    }
    if (!user.isActive) {
      throw forbidden("User account is disabled");
    }
    if (!user.emailVerifiedAt) {
      throw forbidden("Email verification is required");
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === "JsonWebTokenError" || error.name === "TokenExpiredError") {
      return next(unauthorized("Access token is invalid or expired"));
    }
    return next(error);
  }
}

function requireRoles(...roles) {
  return (req, _res, next) => {
    if (!req.user) {
      return next(unauthorized());
    }
    if (!roles.includes(req.user.role)) {
      return next(forbidden(`Requires one of roles: ${roles.join(", ")}`));
    }
    return next();
  };
}

module.exports = { requireAuth, requireRoles };

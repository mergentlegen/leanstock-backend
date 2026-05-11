const bcrypt = require("bcryptjs");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const seedUsers = [
  {
    email: "admin@leanstock.local",
    username: "admin",
    password: "AdminPass1!",
    role: "ADMIN",
  },
  {
    email: "user@leanstock.local",
    username: "ordinary_user",
    password: "UserPass1!",
    role: "STAFF",
  },
];

async function main() {
  const tenant = await prisma.tenant.upsert({
    where: { slug: "demo-market" },
    update: { name: "Demo Market" },
    create: {
      name: "Demo Market",
      slug: "demo-market",
    },
  });

  for (const user of seedUsers) {
    const passwordHash = await bcrypt.hash(user.password, 12);
    const savedUser = await prisma.user.upsert({
      where: { email: user.email },
      update: {
        tenantId: tenant.id,
        username: user.username,
        passwordHash,
        role: user.role,
        emailVerifiedAt: new Date(),
        isActive: true,
      },
      create: {
        tenantId: tenant.id,
        email: user.email,
        username: user.username,
        passwordHash,
        role: user.role,
        emailVerifiedAt: new Date(),
        isActive: true,
      },
    });

    await prisma.auditLog.create({
      data: {
        tenantId: tenant.id,
        actorUserId: savedUser.id,
        action: "USER_REGISTERED",
        entityType: "User",
        entityId: savedUser.id,
        metadata: {
          seeded: true,
          email: user.email,
          role: user.role,
        },
      },
    });
  }

  console.log("Seed users are ready:");
  console.table(seedUsers.map(({ email, username, password, role }) => ({ email, username, password, role })));
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

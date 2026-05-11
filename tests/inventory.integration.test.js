const request = require("supertest");
const { createApp } = require("../src/app");
const { prisma } = require("../src/config/database");

const app = createApp();

beforeEach(async () => {
  await prisma.auditLog.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.emailToken.deleteMany();
  await prisma.inventoryTransfer.deleteMany();
  await prisma.inventoryReservation.deleteMany();
  await prisma.salesRecord.deleteMany();
  await prisma.inventoryItem.deleteMany();
  await prisma.product.deleteMany();
  await prisma.location.deleteMany();
  await prisma.user.deleteMany();
  await prisma.tenant.deleteMany();
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("LeanStock inventory transaction", () => {
  test("transfers stock atomically and prevents overselling", async () => {
    await request(app)
      .post("/auth/register")
      .send({
        tenantName: "Lean Mart",
        email: "merchant@example.com",
        username: "merchant_user",
        password: "StrongPass1!",
      })
      .expect(201);

    const user = await prisma.user.findUnique({ where: { email: "merchant@example.com" } });
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerifiedAt: new Date() },
    });
    const login = await request(app)
      .post("/auth/login")
      .send({ email: "merchant@example.com", password: "StrongPass1!" })
      .expect(200);

    const token = login.body.accessToken;

    const source = await request(app)
      .post("/locations")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Shop A", code: "SHOP_A" })
      .expect(201);

    const destination = await request(app)
      .post("/locations")
      .set("Authorization", `Bearer ${token}`)
      .send({ name: "Shop B", code: "SHOP_B" })
      .expect(201);

    const product = await request(app)
      .post("/products")
      .set("Authorization", `Bearer ${token}`)
      .send({
        sku: "MILK-1L",
        name: "Milk 1L",
        supplierCost: 300,
        basePrice: 500,
        decayPercent: 10,
      })
      .expect(201);

    await request(app)
      .post("/inventory/stock")
      .set("Authorization", `Bearer ${token}`)
      .send({
        productId: product.body.product.id,
        locationId: source.body.location.id,
        quantity: 10,
      })
      .expect(200);

    await request(app)
      .post("/inventory/transfers")
      .set("Authorization", `Bearer ${token}`)
      .send({
        productId: product.body.product.id,
        sourceLocationId: source.body.location.id,
        destinationLocationId: destination.body.location.id,
        quantity: 7,
      })
      .expect(201);

    await request(app)
      .post("/inventory/transfers")
      .set("Authorization", `Bearer ${token}`)
      .send({
        productId: product.body.product.id,
        sourceLocationId: source.body.location.id,
        destinationLocationId: destination.body.location.id,
        quantity: 10,
      })
      .expect(409);

    const sourceStock = await prisma.inventoryItem.findFirst({
      where: { productId: product.body.product.id, locationId: source.body.location.id },
    });
    const destinationStock = await prisma.inventoryItem.findFirst({
      where: { productId: product.body.product.id, locationId: destination.body.location.id },
    });

    expect(sourceStock.quantity).toBe(3);
    expect(destinationStock.quantity).toBe(7);
  });
});

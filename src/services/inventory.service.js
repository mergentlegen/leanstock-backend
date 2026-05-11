const { Prisma } = require("@prisma/client");
const { prisma } = require("../config/database");
const { badRequest, conflict, notFound } = require("../utils/errors");
const { writeAudit } = require("./audit.service");
const { withRedisLock } = require("./lock.service");
const { queueEmail } = require("./email.service");

async function createLocation(user, input) {
  const location = await prisma.location.create({
    data: {
      tenantId: user.tenantId,
      name: input.name,
      code: input.code,
      address: input.address,
    },
  });

  await writeAudit({
    tenantId: user.tenantId,
    actorUserId: user.id,
    action: "LOCATION_CREATED",
    entityType: "Location",
    entityId: location.id,
    metadata: { code: location.code },
  });

  return location;
}

async function createProduct(user, input) {
  if (input.currentPrice && input.currentPrice < input.supplierCost) {
    throw badRequest("Current price cannot be lower than supplier cost on creation");
  }

  const product = await prisma.product.create({
    data: {
      tenantId: user.tenantId,
      sku: input.sku,
      name: input.name,
      supplierName: input.supplierName,
      supplierCost: new Prisma.Decimal(input.supplierCost),
      basePrice: new Prisma.Decimal(input.basePrice),
      currentPrice: new Prisma.Decimal(input.currentPrice ?? input.basePrice),
      deadStockAfterDays: input.deadStockAfterDays,
      decayPercent: new Prisma.Decimal(input.decayPercent),
      decayIntervalHours: input.decayIntervalHours,
      minPricePercent: new Prisma.Decimal(input.minPricePercent),
    },
  });

  await writeAudit({
    tenantId: user.tenantId,
    actorUserId: user.id,
    action: "PRODUCT_CREATED",
    entityType: "Product",
    entityId: product.id,
    metadata: { sku: product.sku },
  });

  return product;
}

async function listProducts(user, { cursor, limit, q }) {
  const rows = await prisma.product.findMany({
    where: {
      tenantId: user.tenantId,
      ...(q ? { name: { contains: q, mode: "insensitive" } } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasNext = rows.length > limit;
  const data = hasNext ? rows.slice(0, limit) : rows;
  return {
    data,
    pageInfo: {
      hasNextPage: hasNext,
      nextCursor: hasNext ? data[data.length - 1].id : null,
    },
  };
}

async function setInventoryStock(user, input) {
  await ensureTenantProductAndLocation(user.tenantId, input.productId, input.locationId);

  const item = await prisma.inventoryItem.upsert({
    where: {
      tenantId_productId_locationId: {
        tenantId: user.tenantId,
        productId: input.productId,
        locationId: input.locationId,
      },
    },
    create: {
      tenantId: user.tenantId,
      productId: input.productId,
      locationId: input.locationId,
      quantity: input.quantity,
      receivedAt: input.receivedAt,
    },
    update: {
      quantity: input.quantity,
      receivedAt: input.receivedAt,
      version: { increment: 1 },
    },
  });

  await writeAudit({
    tenantId: user.tenantId,
    actorUserId: user.id,
    action: "INVENTORY_ADJUSTED",
    entityType: "InventoryItem",
    entityId: item.id,
    metadata: { quantity: item.quantity },
  });

  return item;
}

async function transferInventory(user, input) {
  const lockKeys = [
    `lock:inventory:${user.tenantId}:${input.productId}:${input.sourceLocationId}`,
    `lock:inventory:${user.tenantId}:${input.productId}:${input.destinationLocationId}`,
  ];

  return withRedisLock(lockKeys, async () => {
    return prisma.$transaction(async (tx) => {
      await ensureTenantProductAndLocation(user.tenantId, input.productId, input.sourceLocationId, tx);
      await ensureTenantProductAndLocation(user.tenantId, input.productId, input.destinationLocationId, tx);

      const decrement = await tx.inventoryItem.updateMany({
        where: {
          tenantId: user.tenantId,
          productId: input.productId,
          locationId: input.sourceLocationId,
          quantity: { gte: input.quantity },
        },
        data: {
          quantity: { decrement: input.quantity },
          version: { increment: 1 },
        },
      });

      if (decrement.count !== 1) {
        throw conflict("Insufficient source inventory or concurrent transfer consumed stock first");
      }

      const destination = await tx.inventoryItem.upsert({
        where: {
          tenantId_productId_locationId: {
            tenantId: user.tenantId,
            productId: input.productId,
            locationId: input.destinationLocationId,
          },
        },
        create: {
          tenantId: user.tenantId,
          productId: input.productId,
          locationId: input.destinationLocationId,
          quantity: input.quantity,
        },
        update: {
          quantity: { increment: input.quantity },
          version: { increment: 1 },
        },
      });

      const transfer = await tx.inventoryTransfer.create({
        data: {
          tenantId: user.tenantId,
          productId: input.productId,
          sourceLocationId: input.sourceLocationId,
          destinationLocationId: input.destinationLocationId,
          quantity: input.quantity,
          createdByUserId: user.id,
        },
      });

      await writeAudit({
        tx,
        tenantId: user.tenantId,
        actorUserId: user.id,
        action: "INVENTORY_TRANSFERRED",
        entityType: "InventoryTransfer",
        entityId: transfer.id,
        metadata: input,
      });

      await queueEmail({
        to: user.email,
        subject: "Inventory transfer completed",
        text: `Transfer completed: ${input.quantity} units moved between locations.`,
        html: `<p>Transfer completed: <b>${input.quantity}</b> units moved between locations.</p>`,
        eventType: "INVENTORY_TRANSFERRED",
        metadata: { tenantId: user.tenantId, transferId: transfer.id },
      });

      return { transfer, destination };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  });
}

async function reserveInventory(user, input) {
  const lockKey = `lock:reservation:${user.tenantId}:${input.productId}:${input.locationId}`;
  return withRedisLock([lockKey], async () => {
    return prisma.$transaction(async (tx) => {
      await ensureTenantProductAndLocation(user.tenantId, input.productId, input.locationId, tx);
      const item = await tx.inventoryItem.findFirst({
        where: {
          tenantId: user.tenantId,
          productId: input.productId,
          locationId: input.locationId,
        },
      });

      if (!item || item.quantity - item.reservedQuantity < input.quantity) {
        throw conflict("Not enough available inventory to reserve");
      }

      await tx.inventoryItem.update({
        where: { id: item.id },
        data: {
          reservedQuantity: { increment: input.quantity },
          version: { increment: 1 },
        },
      });

      const reservation = await tx.inventoryReservation.create({
        data: {
          tenantId: user.tenantId,
          productId: input.productId,
          locationId: input.locationId,
          quantity: input.quantity,
          token: `rsv_${cryptoRandomToken()}`,
          expiresAt: new Date(Date.now() + input.ttlSeconds * 1000),
          createdByUserId: user.id,
        },
      });

      await writeAudit({
        tx,
        tenantId: user.tenantId,
        actorUserId: user.id,
        action: "INVENTORY_RESERVED",
        entityType: "InventoryReservation",
        entityId: reservation.id,
        metadata: { quantity: input.quantity },
      });

      await queueEmail({
        to: user.email,
        subject: "Inventory reservation created",
        text: `Reservation ${reservation.token} created for ${reservation.quantity} units.`,
        html: `<p>Reservation <b>${reservation.token}</b> created for ${reservation.quantity} units.</p>`,
        eventType: "INVENTORY_RESERVED",
        metadata: { tenantId: user.tenantId, reservationId: reservation.id },
      });

      return reservation;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  });
}

async function commitReservation(user, token) {
  return changeReservationStatus(user, token, "COMMITTED");
}

async function cancelReservation(user, token) {
  return changeReservationStatus(user, token, "CANCELLED");
}

async function changeReservationStatus(user, token, nextStatus) {
  const reservation = await prisma.inventoryReservation.findFirst({
    where: {
      tenantId: user.tenantId,
      token,
      status: "RESERVED",
    },
  });

  if (!reservation) {
    throw notFound("Active reservation not found");
  }
  if (reservation.expiresAt <= new Date()) {
    await prisma.inventoryReservation.update({
      where: { id: reservation.id },
      data: { status: "EXPIRED" },
    });
    throw conflict("Reservation has expired");
  }

  const lockKey = `lock:reservation:${user.tenantId}:${reservation.productId}:${reservation.locationId}`;
  return withRedisLock([lockKey], async () => {
    return prisma.$transaction(async (tx) => {
      const item = await tx.inventoryItem.findFirst({
        where: {
          tenantId: user.tenantId,
          productId: reservation.productId,
          locationId: reservation.locationId,
        },
      });
      if (!item || item.reservedQuantity < reservation.quantity) {
        throw conflict("Reservation state is inconsistent");
      }

      await tx.inventoryItem.update({
        where: { id: item.id },
        data: nextStatus === "COMMITTED"
          ? {
            quantity: { decrement: reservation.quantity },
            reservedQuantity: { decrement: reservation.quantity },
            version: { increment: 1 },
          }
          : {
            reservedQuantity: { decrement: reservation.quantity },
            version: { increment: 1 },
          },
      });

      const updated = await tx.inventoryReservation.update({
        where: { id: reservation.id },
        data: { status: nextStatus },
      });

      await writeAudit({
        tx,
        tenantId: user.tenantId,
        actorUserId: user.id,
        action: nextStatus === "COMMITTED" ? "INVENTORY_RESERVATION_COMMITTED" : "INVENTORY_RESERVATION_CANCELLED",
        entityType: "InventoryReservation",
        entityId: reservation.id,
        metadata: { token },
      });

      return updated;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  });
}

async function recordSale(user, input) {
  const lockKey = `lock:sale:${user.tenantId}:${input.productId}:${input.locationId}`;
  return withRedisLock([lockKey], async () => {
    return prisma.$transaction(async (tx) => {
      await ensureTenantProductAndLocation(user.tenantId, input.productId, input.locationId, tx);
      const decrement = await tx.inventoryItem.updateMany({
        where: {
          tenantId: user.tenantId,
          productId: input.productId,
          locationId: input.locationId,
          quantity: { gte: input.quantity },
        },
        data: {
          quantity: { decrement: input.quantity },
          version: { increment: 1 },
        },
      });
      if (decrement.count !== 1) {
        throw conflict("Not enough stock to record sale");
      }

      const sale = await tx.salesRecord.create({
        data: {
          tenantId: user.tenantId,
          productId: input.productId,
          locationId: input.locationId,
          quantity: input.quantity,
          unitPrice: new Prisma.Decimal(input.unitPrice),
          soldAt: input.soldAt,
          createdByUserId: user.id,
        },
      });

      await writeAudit({
        tx,
        tenantId: user.tenantId,
        actorUserId: user.id,
        action: "SALE_RECORDED",
        entityType: "SalesRecord",
        entityId: sale.id,
        metadata: { quantity: input.quantity },
      });

      return sale;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  });
}

async function forecastReorder(user, { productId, locationId, days = 30, leadTimeDays = 7, safetyStock = 5 }) {
  await ensureTenantProductAndLocation(user.tenantId, productId, locationId);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const sales = await prisma.salesRecord.findMany({
    where: {
      tenantId: user.tenantId,
      productId,
      locationId,
      soldAt: { gte: since },
    },
  });
  const item = await prisma.inventoryItem.findFirst({
    where: {
      tenantId: user.tenantId,
      productId,
      locationId,
    },
  });

  const totalSold = sales.reduce((sum, sale) => sum + sale.quantity, 0);
  const averageDailyDemand = totalSold / days;
  const reorderPoint = Math.ceil(averageDailyDemand * leadTimeDays + safetyStock);
  const availableQuantity = item ? item.quantity - item.reservedQuantity : 0;
  const recommendedOrderQuantity = Math.max(reorderPoint - availableQuantity, 0);

  const forecast = {
    productId,
    locationId,
    windowDays: days,
    leadTimeDays,
    safetyStock,
    totalSold,
    averageDailyDemand: roundMoney(averageDailyDemand),
    availableQuantity,
    reorderPoint,
    shouldReorder: availableQuantity <= reorderPoint,
    recommendedOrderQuantity,
  };

  await writeAudit({
    tenantId: user.tenantId,
    actorUserId: user.id,
    action: "REORDER_FORECAST_VIEWED",
    entityType: "Product",
    entityId: productId,
    metadata: forecast,
  });

  if (forecast.shouldReorder) {
    await queueEmail({
      to: user.email,
      subject: "LeanStock reorder alert",
      text: `Reorder suggested for product ${productId}. Recommended quantity: ${recommendedOrderQuantity}.`,
      html: `<p>Reorder suggested.</p><p>Recommended quantity: <b>${recommendedOrderQuantity}</b></p>`,
      eventType: "REORDER_ALERT",
      metadata: { tenantId: user.tenantId, productId, locationId },
    });
  }

  return forecast;
}

async function applyDeadStockDecay(user, now = new Date()) {
  return applyDeadStockDecayForTenant({
    tenantId: user.tenantId,
    actorUserId: user.id,
    now,
  });
}

async function applyDeadStockDecayForTenant({ tenantId, actorUserId = null, now = new Date() }) {
  const inventoryRows = await prisma.inventoryItem.findMany({
    where: {
      tenantId,
      quantity: { gt: 0 },
    },
    include: {
      product: true,
    },
  });

  const updatedProducts = [];
  const touchedProductIds = new Set();

  for (const row of inventoryRows) {
    if (touchedProductIds.has(row.productId)) {
      continue;
    }
    const decision = calculateDeadStockPrice({
      currentPrice: Number(row.product.currentPrice),
      basePrice: Number(row.product.basePrice),
      receivedAt: row.receivedAt,
      lastDecayAt: row.lastDecayAt,
      now,
      deadStockAfterDays: row.product.deadStockAfterDays,
      decayPercent: Number(row.product.decayPercent),
      decayIntervalHours: row.product.decayIntervalHours,
      minPricePercent: Number(row.product.minPricePercent),
    });

    if (!decision.shouldDecay) {
      continue;
    }

    const product = await prisma.product.update({
      where: {
        id: row.productId,
        tenantId,
      },
      data: {
        currentPrice: new Prisma.Decimal(decision.nextPrice),
      },
    });

    await prisma.inventoryItem.updateMany({
      where: {
        tenantId,
        productId: row.productId,
      },
      data: {
        lastDecayAt: now,
        version: { increment: 1 },
      },
    });

    await writeAudit({
      tenantId,
      actorUserId,
      action: "DEAD_STOCK_DECAY_APPLIED",
      entityType: "Product",
      entityId: product.id,
      metadata: decision,
    });

    touchedProductIds.add(row.productId);
    updatedProducts.push(product);
  }

  return { updatedCount: updatedProducts.length, products: updatedProducts };
}

function calculateDeadStockPrice({
  currentPrice,
  basePrice,
  receivedAt,
  lastDecayAt,
  now,
  deadStockAfterDays,
  decayPercent,
  decayIntervalHours,
  minPricePercent,
}) {
  const msPerDay = 24 * 60 * 60 * 1000;
  const ageDays = (now.getTime() - receivedAt.getTime()) / msPerDay;
  if (ageDays <= deadStockAfterDays) {
    return { shouldDecay: false, reason: "NOT_OLD_ENOUGH", currentPrice };
  }

  const reference = lastDecayAt ?? new Date(receivedAt.getTime() + deadStockAfterDays * msPerDay);
  const hoursSinceLastDecay = (now.getTime() - reference.getTime()) / (60 * 60 * 1000);
  if (hoursSinceLastDecay < decayIntervalHours) {
    return { shouldDecay: false, reason: "DECAY_INTERVAL_NOT_REACHED", currentPrice };
  }

  const floor = roundMoney(basePrice * (minPricePercent / 100));
  const discounted = roundMoney(currentPrice * (1 - decayPercent / 100));
  const nextPrice = Math.max(discounted, floor);

  if (nextPrice >= currentPrice) {
    return { shouldDecay: false, reason: "PRICE_FLOOR_REACHED", currentPrice, floor };
  }

  return {
    shouldDecay: true,
    previousPrice: roundMoney(currentPrice),
    nextPrice,
    floor,
    ageDays: Math.floor(ageDays),
    decayPercent,
  };
}

async function ensureTenantProductAndLocation(tenantId, productId, locationId, tx = prisma) {
  const [product, location] = await Promise.all([
    tx.product.findFirst({ where: { id: productId, tenantId } }),
    tx.location.findFirst({ where: { id: locationId, tenantId } }),
  ]);
  if (!product) {
    throw notFound("Product not found for this tenant");
  }
  if (!location) {
    throw notFound("Location not found for this tenant");
  }
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function cryptoRandomToken() {
  return require("crypto").randomBytes(18).toString("base64url");
}

module.exports = {
  createLocation,
  createProduct,
  listProducts,
  setInventoryStock,
  transferInventory,
  reserveInventory,
  commitReservation,
  cancelReservation,
  recordSale,
  forecastReorder,
  applyDeadStockDecay,
  applyDeadStockDecayForTenant,
  calculateDeadStockPrice,
};

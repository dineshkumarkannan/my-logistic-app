import { prisma } from "../../../config/database.js";
import { type Order, type OrderStatus } from "@prisma/client";

export class OrderRepository {
  async createOrder(
    tenantId: string,
    data: {
      customerId: string;
      pickupAddress: string;
      dropoffAddress: string;
    },
  ): Promise<Order> {
    return prisma.order.create({
      data: {
        tenantId,
        customerId: data.customerId,
        pickupAddress: data.pickupAddress,
        dropoffAddress: data.dropoffAddress,
      },
    });
  }

  async findById(id: string, tenantId: string): Promise<Order | null> {
    return prisma.order.findFirst({
      where: { id, tenantId, deletedAt: null },
    });
  }

  async findPaginated(
    tenantId: string,
    limit: number,
    cursor?: string,
    status?: OrderStatus,
  ): Promise<Order[]> {
    return prisma.order.findMany({
      take: limit,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
      where: {
        tenantId,
        status: status || undefined,
        deletedAt: null,
      },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * The version predicate and increment are part of one SQL UPDATE. Two
   * requests reading version N cannot both update the row: only one can
   * satisfy `version = N`, and the other receives count 0.
   */
  async updateOrderWithLock(
    orderId: string,
    tenantId: string,
    newData: Partial<Order>,
    expectedVersion: number,
  ): Promise<Order | null> {
    const updateResult = await prisma.order.updateMany({
      where: {
        id: orderId,
        tenantId,
        deletedAt: null,
        version: expectedVersion,
      },
      data: {
        ...newData,
        version: { increment: 1 },
      },
    });

    if (updateResult.count === 0) return null;
    return this.findById(orderId, tenantId);
  }
}

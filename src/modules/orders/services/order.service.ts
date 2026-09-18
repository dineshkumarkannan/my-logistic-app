import { AppError } from "../../../middlewares/error.middleware.js";
import { OrderStatus } from "@prisma/client";
import { globalEventBus } from "../../../config/eventBus.js";
import type { AssignDriverInput, CreateOrderInput, GetOrdersQuery } from "../dtos/order.dto.js";
import { OrderRepository } from "../repositories/order.repository.js";

export class OrderService {
  constructor(private readonly orderRepository = new OrderRepository()) {}

  async create(tenantId: string, payload: CreateOrderInput) {
    return this.orderRepository.createOrder(tenantId, payload);
  }

  async list(tenantId: string, query: GetOrdersQuery) {
    const orders = await this.orderRepository.findPaginated(
      tenantId,
      query.limit,
      query.cursor,
      query.status as OrderStatus | undefined,
    );

    const nextCursor = orders.length === query.limit
      ? orders[orders.length - 1]?.id ?? null
      : null;

    return { orders, nextCursor };
  }

  async assignDriver(
    orderId: string,
    tenantId: string,
    input: AssignDriverInput,
  ) {
    const order = await this.orderRepository.findById(orderId, tenantId);
    if (!order) {
      throw new AppError("The requested shipping order profile does not exist.", 404);
    }

    // Check the client snapshot before workflow validation. If another
    // dispatcher has already advanced the row, this is a stale-write conflict
    // even when the new status would otherwise be invalid for assignment.
    if (order.version !== input.currentVersion) {
      throw new AppError(
        "CONCURRENCY_CONFLICT: The order data was modified by another operator. Please refresh and retry.",
        409,
      );
    }

    if (order.status !== OrderStatus.PENDING) {
      throw new AppError("This shipment job has already been processed or routed.", 400);
    }

    const updatedOrder = await this.orderRepository.updateOrderWithLock(
      orderId,
      tenantId,
      { driverId: input.driverId, status: OrderStatus.ASSIGNED },
      input.currentVersion,
    );

    if (!updatedOrder) {
      throw new AppError(
        "CONCURRENCY_CONFLICT: The order data was modified by another operator. Please refresh and retry.",
        409,
      );
    }

    globalEventBus.emit("order.status.updated", {
      tenantId: updatedOrder.tenantId,
      orderId: updatedOrder.id,
      status: updatedOrder.status,
      driverId: updatedOrder.driverId ?? undefined,
      customerId: updatedOrder.customerId,
    });

    return updatedOrder;
  }
}

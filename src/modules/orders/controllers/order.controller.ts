import type { Request, Response } from "express";
import type {
  AssignDriverInput,
  CreateOrderInput,
  GetOrdersQuery,
} from "../dtos/order.dto.js";
import { OrderService } from "../services/order.service.js";

export class OrderController {
  private readonly orderService = new OrderService();

  create = async (request: Request, response: Response): Promise<void> => {
    const order = await this.orderService.create(
      request.user!.tenantId,
      request.body as CreateOrderInput,
    );

    response.status(201).json({ success: true, data: order });
  };

  list = async (request: Request, response: Response): Promise<void> => {
    const result = await this.orderService.list(
      request.user!.tenantId,
      response.locals.validatedQuery as GetOrdersQuery,
    );

    response.status(200).json({ success: true, ...result });
  };

  assign = async (request: Request, response: Response): Promise<void> => {
    const updatedOrder = await this.orderService.assignDriver(
      request.params.id as string,
      request.user!.tenantId,
      request.body as AssignDriverInput,
    );

    response.status(200).json({
      success: true,
      message: "Driver route allocation successfully locked into the ledger system.",
      data: updatedOrder,
    });
  };
}

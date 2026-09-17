import { z } from "zod";

const orderStatusSchema = z.enum([
  "PENDING",
  "ASSIGNED",
  "IN_TRANSIT",
  "COMPLETED",
  "CANCELLED",
]);

export const CreateOrderSchema = z.object({
  customerId: z.string().uuid(),
  pickupAddress: z.string().trim().min(5),
  dropoffAddress: z.string().trim().min(5),
});

export const AssignDriverSchema = z.object({
  driverId: z.string().uuid(),
  currentVersion: z.number().int().positive(),
});

export const OrderIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const GetOrdersQuerySchema = z.object({
  status: orderStatusSchema.optional(),
  limit: z.coerce.number().int().positive().max(100).default(10),
  cursor: z.string().uuid().optional(),
});

export type CreateOrderInput = z.infer<typeof CreateOrderSchema>;
export type AssignDriverInput = z.infer<typeof AssignDriverSchema>;
export type GetOrdersQuery = z.infer<typeof GetOrdersQuerySchema>;
export type OrderStatusValue = z.infer<typeof orderStatusSchema>;

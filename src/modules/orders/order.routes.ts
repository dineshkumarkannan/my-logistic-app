import { UserRole } from "@prisma/client";
import { Router } from "express";
import { catchAsync } from "../../middlewares/catchAsync.js";
import { validate } from "../../middlewares/validate.middleware.js";
import { authorizeRoles } from "../auth/middlewares/rbac.middleware.js";
import { verifyJwtGuard } from "../auth/middlewares/auth.middleware.js";
import { OrderController } from "./controllers/order.controller.js";
import {
  AssignDriverSchema,
  CreateOrderSchema,
  GetOrdersQuerySchema,
  OrderIdParamsSchema,
} from "./dtos/order.dto.js";

const router = Router();
const controller = new OrderController();

router.use(verifyJwtGuard);

router.post(
  "/",
  authorizeRoles(UserRole.SUPER_ADMIN, UserRole.ORG_MANAGER, UserRole.DISPATCHER),
  validate({ body: CreateOrderSchema }),
  catchAsync(controller.create),
);

router.get(
  "/",
  authorizeRoles(UserRole.SUPER_ADMIN, UserRole.ORG_MANAGER, UserRole.DISPATCHER),
  validate({ query: GetOrdersQuerySchema }),
  catchAsync(controller.list),
);

router.patch(
  "/:id/assign",
  authorizeRoles(UserRole.SUPER_ADMIN, UserRole.DISPATCHER),
  validate({ params: OrderIdParamsSchema, body: AssignDriverSchema }),
  catchAsync(controller.assign),
);

export default router;

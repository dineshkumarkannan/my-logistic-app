import { Router } from "express";
import { z } from "zod";
import { catchAsync } from "../../middlewares/catchAsync.js";
import { validate } from "../../middlewares/validate.middleware.js";
import { AppError } from "../../middlewares/error.middleware.js";
import { verifyJwtGuard } from "../auth/middlewares/auth.middleware.js";
import { TrackingService } from "./services/tracking.service.js";

const router = Router();
const service = new TrackingService();

router.get(
  "/live/:driverId",
  verifyJwtGuard,
  validate({ params: z.object({ driverId: z.string().uuid() }) }),
  catchAsync(async (request, response) => {
    const data = await service.getLiveLocation(
      request.user!.tenantId,
      request.params.driverId as string,
    );
    if (!data) {
      throw new AppError("No active live data tracking payload found for this driver.", 404);
    }
    response.status(200).json({ success: true, data });
  }),
);

router.get(
  "/history/:orderId",
  verifyJwtGuard,
  validate({ params: z.object({ orderId: z.string().uuid() }) }),
  catchAsync(async (request, response) => {
    const data = await service.getOrderHistory(
      request.user!.tenantId,
      request.params.orderId as string,
    );
    response.status(200).json({ success: true, count: data.length, data });
  }),
);

export default router;

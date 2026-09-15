import { Router } from "express";
import { catchAsync } from "../../middlewares/catchAsync.js";
import { validateBody } from "../../middlewares/validate.middleware.js";
import { AuthController } from "./controllers/auth.controller.js";
import { LoginSchema, RegisterTenantSchema } from "./dtos/auth.dto.js";
import { verifyJwtGuard } from "./middlewares/auth.middleware.js";

const router = Router();
const controller = new AuthController();

router.post(
  "/register",
  validateBody(RegisterTenantSchema),
  catchAsync(controller.register),
);
router.post("/login", validateBody(LoginSchema), catchAsync(controller.login));
router.post("/logout", verifyJwtGuard, catchAsync(controller.logout));

export const authRouter = router;
export default router;

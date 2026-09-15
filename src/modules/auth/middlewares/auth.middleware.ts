import type { RequestHandler } from "express";
import { UserRole } from "@prisma/client";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { env } from "../../../config/environment.js";
import { redisClient } from "../../../config/redis.js";
import { AppError } from "../../../middlewares/error.middleware.js";

declare global {
  namespace Express {
    interface Request {
      user?: {
        userId: string;
        tenantId: string;
        role: UserRole;
        email: string;
      };
    }
  }
}

export const authenticate: RequestHandler = async (
  request,
  _response,
  next,
) => {
  const header = request.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;

  if (!token) {
    next(new AppError("Authentication required", 401));
    return;
  }

  try {
    const verified = jwt.verify(token, env.JWT_ACCESS_SECRET);

    if (typeof verified === "string") {
      throw new AppError("Invalid authentication token signature.", 401);
    }

    const payload = verified as JwtPayload & {
      userId?: string;
      tenantId?: string;
      role?: UserRole;
      email?: string;
    };

    if (
      typeof payload.userId !== "string" ||
      typeof payload.tenantId !== "string" ||
      !payload.role ||
      !Object.values(UserRole).includes(payload.role) ||
      typeof payload.email !== "string"
    ) {
      throw new AppError("Invalid authentication token claims.", 401);
    }

    const activeSessionToken = await redisClient.get(
      `session:${payload.tenantId}:${payload.userId}`,
    );

    if (!activeSessionToken) {
      throw new AppError(
        "The active cryptographic session has expired or been revoked.",
        401,
      );
    }

    request.user = {
      userId: payload.userId,
      tenantId: payload.tenantId,
      role: payload.role,
      email: payload.email,
    };

    next();
  } catch (error: unknown) {
    if (error instanceof AppError) {
      next(error);
      return;
    }

    if (error instanceof jwt.TokenExpiredError) {
      next(new AppError("The access token provided has expired.", 401));
      return;
    }

    if (error instanceof jwt.JsonWebTokenError) {
      next(new AppError("Invalid authentication token signature.", 401));
      return;
    }

    next(
      error instanceof Error ? error : new Error("Authentication guard failed"),
    );
  }
};

export const verifyJwtGuard = authenticate;

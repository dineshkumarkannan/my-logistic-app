import type { RequestHandler } from "express";
import { UserRole } from '@prisma/client';
import { AppError } from "../../../middlewares/error.middleware.js";

export const authorizeRoles = (...allowedRoles: UserRole[]) : RequestHandler => (request, _respose, next) => {
    if(!request.user || !allowedRoles.includes(request.user.role)) {
        next(new AppError('You do not have permission to access this resource', 403));
        return;
    }

    next();
}
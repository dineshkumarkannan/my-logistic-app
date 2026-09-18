import type { ErrorRequestHandler } from "express";
import { getCorrelationId } from "./trace.middleware.js";
import { logger } from "../utils/logger.js";

export class AppError extends Error {
    public readonly isOperational = true;

    constructor(
        message: string,
        public readonly statusCode: number,
        public readonly details?: unknown
    ) {
        super(message);
        this.name = 'AppError';
        Error.captureStackTrace(this, this.constructor);
    }
}

export const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
    const statusCode = error instanceof AppError ? error.statusCode : 500;
    const isOperational = error instanceof AppError ? error.isOperational : false;
    const message = error instanceof Error ? error.message : 'Internal server error';

    logger.error({
        correlationId: getCorrelationId(),
        method: request.method,
        path: request.path,
        errorMessage: message,
        stack: process.env.NODE_ENV === 'development' && error instanceof Error
            ? error.stack
            : undefined,
    }, 'Operational exception intercepted');

    if(process.env.NODE_ENV === 'development') {
        response.status(statusCode).json({
            success: false,
            message,
            stack: error instanceof Error ? error.stack : undefined,
            isOperational,
            ...(error instanceof AppError && error.details ? { details: error.details } : {})
        });
        return;
    }

    response.status(statusCode).json({
        success: false,
        message: statusCode === 500 ? 'Internal Server System Error' : message
    });
};

export const errorMiddleware = errorHandler;

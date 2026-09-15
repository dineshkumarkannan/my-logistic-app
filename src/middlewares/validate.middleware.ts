import type { RequestHandler } from "express";
import type { ZodType } from "zod";
import { AppError } from "./error.middleware.js";

export const validateBody =
  (schema: ZodType): RequestHandler =>
  (request, _response, next) => {
    const result = schema.safeParse(request.body);

    if (!result.success) {
      next(
        new AppError(
          "The submitted request payload failed strict schema validation.",
          400,
          result.error.issues.map((issue) => ({
            field: issue.path.join(".") || "body",
            message: issue.message,
          })),
        ),
      );
      return;
    }

    request.body = result.data;
    next();
  };

export const validate =
  (schema: ZodType): RequestHandler =>
  (request, _response, next) => {
    const result = schema.safeParse({
      body: request.body,
      params: request.params,
      query: request.query,
    });

    if (!result.success) {
      next(new AppError("Validation failed", 400, result.error.flatten()));
      return;
    }

    const data = result.data as {
      body: unknown;
      params: Record<string, string>;
      query: Record<string, unknown>;
    };

    request.body = data.body;
    request.params = data.params;
    request.query = data.query as typeof request.query;
    next();
  };

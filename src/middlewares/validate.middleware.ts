import type { RequestHandler } from "express";
import { z, type ZodType } from "zod";
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

type RequestSchema = ZodType | {
  body?: ZodType;
  params?: ZodType;
  query?: ZodType;
};

export const validate =
  (schema: RequestSchema): RequestHandler =>
  (request, response, next) => {
    const requestSchema = "safeParse" in schema ? schema : z.object({
      body: schema.body ?? z.unknown(),
      params: schema.params ?? z.unknown(),
      query: schema.query ?? z.unknown(),
    });
    const result = requestSchema.safeParse({
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
    // Express 5 exposes request.query through a read-only getter that may
    // return a fresh object. Keep transformed query data in response locals
    // so downstream handlers receive Zod defaults and coercions reliably.
    response.locals.validatedQuery = data.query;
    next();
  };

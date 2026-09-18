import type { NextFunction, Request, Response } from "express";
import { AsyncLocalStorage } from "node:async_hooks";
import { v4 as uuidv4 } from "uuid";

export const traceStorage = new AsyncLocalStorage<Map<string, string>>();

const getRequestedCorrelationId = (request: Request): string | undefined => {
  const header = request.headers["x-correlation-id"];
  const value = Array.isArray(header) ? header[0] : header;

  if (!value || !/^[a-zA-Z0-9._:-]{1,128}$/.test(value)) {
    return undefined;
  }

  return value;
};

export const traceMiddleware = (
  request: Request,
  response: Response,
  next: NextFunction,
): void => {
  const correlationId = getRequestedCorrelationId(request) ?? uuidv4();
  response.setHeader("x-correlation-id", correlationId);

  const store = new Map<string, string>([["correlationId", correlationId]]);
  traceStorage.run(store, next);
};

export const getCorrelationId = (): string => {
  return traceStorage.getStore()?.get("correlationId") ?? "SYSTEM";
};

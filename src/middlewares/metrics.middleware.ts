import type { NextFunction, Request, Response } from "express";
import client from "prom-client";

client.collectDefaultMetrics();

export const httpRequestCounter = new client.Counter({
  name: "http_requests_total",
  help: "Total number of incoming HTTP requests",
  labelNames: ["method", "route", "status"],
});

export const httpDurationSummary = new client.Summary({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["method", "route"],
});

const getRouteLabel = (request: Request): string => {
  const route = request.route?.path;
  if (!route) {
    return request.path;
  }

  return `${request.baseUrl}${String(route)}`;
};

export const metricsMiddleware = (
  request: Request,
  response: Response,
  next: NextFunction,
): void => {
  const endTimer = httpDurationSummary.startTimer();

  response.on("finish", () => {
    const route = getRouteLabel(request);
    const labels = {
      method: request.method,
      route,
      status: response.statusCode.toString(),
    };

    httpRequestCounter.inc(labels);
    endTimer({ method: labels.method, route: labels.route });
  });

  next();
};

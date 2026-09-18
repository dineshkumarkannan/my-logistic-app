import pino from "pino";
import { getCorrelationId } from "../middlewares/trace.middleware.js";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  formatters: {
    level: (label) => ({ level: label.toUpperCase() }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  mixin: () => ({ correlationId: getCorrelationId() }),
});

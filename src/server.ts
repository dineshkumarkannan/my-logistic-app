import app from "./app.js";
import http from "node:http";
import mongoose from "mongoose";
import { prisma } from "./config/database.js";
import { env } from "./config/environment.js";
import { connectRedis, redisClient } from "./config/redis.js";
import { TrackingGateway } from "./modules/tracking/gateways/tracking.gateway.js";
import {
  bootstrapNotificationsModule,
  shutdownNotificationsModule,
} from "./modules/notifications/index.js";
import { logger } from "./utils/logger.js";

const PORT = env.PORT;
const server = http.createServer(app);

const startServer = async (): Promise<void> => {
  await connectRedis();
  await prisma.$connect();
  logger.info("PostgreSQL transactional storage connected.");

  mongoose.set("strictQuery", true);
  await mongoose.connect(env.MONGODB_URI);
  logger.info("MongoDB tracking history connected.");

  new TrackingGateway(server);
  logger.info("Socket.io telemetry gateway mounted.");

  bootstrapNotificationsModule();

  server.listen(PORT, "0.0.0.0", () => {
    logger.info({ port: PORT }, "Logistics API listening.");
  });
};

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, "Shutdown signal received.");

  await shutdownNotificationsModule();

  if (redisClient.isOpen) {
    await redisClient.quit();
  }

  await mongoose.disconnect();
  await prisma.$disconnect();
  server.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

startServer().catch(async (error: unknown) => {
  logger.fatal({ err: error }, "Critical system initialization failure.");

  await shutdownNotificationsModule();

  if (redisClient.isOpen) {
    await redisClient.quit();
  }

  await mongoose.disconnect();
  await prisma.$disconnect();
  server.close();
  process.exit(1);
});

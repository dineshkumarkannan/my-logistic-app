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

const PORT = env.PORT;
const server = http.createServer(app);

const startServer = async (): Promise<void> => {
  await connectRedis();
  await prisma.$connect();
  console.log("PostgreSQL transactional storage connected.");

  mongoose.set("strictQuery", true);
  await mongoose.connect(env.MONGODB_URI);
  console.log("MongoDB tracking history connected.");

  new TrackingGateway(server);
  console.log("Socket.io telemetry gateway mounted.");

  bootstrapNotificationsModule();

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Logistics API listening on http://localhost:${PORT}/health`);
  });
};

const shutdown = async (signal: string): Promise<void> => {
  console.log(`${signal} received. Shutting down gracefully.`);

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
  console.error("Critical system initialization failure", error);

  await shutdownNotificationsModule();

  if (redisClient.isOpen) {
    await redisClient.quit();
  }

  await mongoose.disconnect();
  await prisma.$disconnect();
  server.close();
  process.exit(1);
});

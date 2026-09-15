import app from "./app.js";
import { prisma } from "./config/database.js";
import { env } from "./config/environment.js";
import { connectRedis, redisClient } from "./config/redis.js";

const PORT = env.PORT;

const startServer = async (): Promise<void> => {
  await connectRedis();
  await prisma.$connect();
  console.log("PostgreSQL transactional storage connected.");

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Logistics API listening on http://localhost:${PORT}/health`);
  });
};

const shutdown = async (signal: string): Promise<void> => {
  console.log(`${signal} received. Shutting down gracefully.`);

  if (redisClient.isOpen) {
    await redisClient.quit();
  }

  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

startServer().catch(async (error: unknown) => {
  console.error("Critical system initialization failure", error);

  if (redisClient.isOpen) {
    await redisClient.quit();
  }

  await prisma.$disconnect();
  process.exit(1);
});

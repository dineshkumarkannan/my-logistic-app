import type { Server as HttpServer } from "node:http";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { Server, type Socket } from "socket.io";
import { z } from "zod";
import { env } from "../../../config/environment.js";
import { redisClient } from "../../../config/redis.js";
import { UserRole } from "@prisma/client";
import { TrackingService } from "../services/tracking.service.js";

type SocketUser = {
  userId: string;
  tenantId: string;
  role: UserRole;
  email: string;
};

type TrackingSocket = Socket & { data: { user: SocketUser } };

const driverPingSchema = z.object({
  orderId: z.string().uuid(),
  lat: z.number().finite().min(-90).max(90),
  lng: z.number().finite().min(-180).max(180),
});

const uuidSchema = z.string().uuid();

export class TrackingGateway {
  private readonly io: Server;
  private readonly trackingService = new TrackingService();

  constructor(server: HttpServer) {
    this.io = new Server(server, {
      cors: { origin: "*", methods: ["GET", "POST"] },
    });
    this.initializeHandlers();
  }

  private initializeHandlers(): void {
    this.io.use(async (socket, next) => {
      const authToken = socket.handshake.auth.token ?? socket.handshake.query.token;
      const token = Array.isArray(authToken) ? authToken[0] : authToken;

      if (typeof token !== "string" || token.length === 0) {
        next(new Error("Authentication failed: Missing token."));
        return;
      }

      try {
        const verified = jwt.verify(token, env.JWT_ACCESS_SECRET);
        if (typeof verified === "string") {
          throw new Error("Invalid token claims");
        }

        const payload = verified as JwtPayload & Partial<SocketUser>;
        if (
          typeof payload.userId !== "string" ||
          typeof payload.tenantId !== "string" ||
          typeof payload.email !== "string" ||
          !payload.role ||
          !Object.values(UserRole).includes(payload.role)
        ) {
          throw new Error("Invalid token claims");
        }

        const activeSession = await redisClient.get(
          `session:${payload.tenantId}:${payload.userId}`,
        );
        if (!activeSession) {
          throw new Error("Session revoked or expired");
        }

        (socket as TrackingSocket).data.user = {
          userId: payload.userId,
          tenantId: payload.tenantId,
          role: payload.role,
          email: payload.email,
        };
        next();
      } catch {
        next(new Error("Authentication failed: Invalid or inactive token."));
      }
    });

    this.io.on("connection", (rawSocket) => {
      const socket = rawSocket as TrackingSocket;
      const user = socket.data.user;
      console.log(
        `WebSocket tracking channel active for ${user.userId} under tenant ${user.tenantId}`,
      );

      socket.on("join:order_track", (orderId: string) => {
        if (!uuidSchema.safeParse(orderId).success) return;
        socket.join(`room:order:${user.tenantId}:${orderId}`);
      });

      socket.on("driver:ping", async (payload: unknown) => {
        if (user.role !== UserRole.DRIVER) return;

        const result = driverPingSchema.safeParse(payload);
        if (!result.success) return;

        try {
          const { orderId, lat, lng } = result.data;
          await this.trackingService.processDriverPing(
            user.tenantId,
            user.userId,
            orderId,
            lat,
            lng,
          );

          this.io
            .to(`room:order:${user.tenantId}:${orderId}`)
            .emit("tracking:update", {
              driverId: user.userId,
              orderId,
              coordinates: { lat, lng },
              timestamp: new Date(),
            });
        } catch (error: unknown) {
          console.error("Driver telemetry processing failed", error);
          socket.emit("tracking:error", {
            message: "Telemetry could not be recorded.",
          });
        }
      });

      socket.on("disconnect", () => {
        console.log(`Tracking channel closed for user ${user.userId}`);
      });
    });
  }
}

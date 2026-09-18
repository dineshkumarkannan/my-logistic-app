import { redisClient } from "../../../config/redis.js";
import { LocationHistory } from "../models/locationHistory.model.js";

export type LiveLocation = {
  tenantId: string;
  orderId: string;
  lat: number;
  lng: number;
  timestamp: Date;
};

const liveGeoKey = (tenantId: string): string => `tracking:live:${tenantId}`;
const liveHashKey = (tenantId: string, driverId: string): string =>
  `tracking:latest:${tenantId}:${driverId}`;

export class TrackingService {
  async processDriverPing(
    tenantId: string,
    driverId: string,
    orderId: string,
    lat: number,
    lng: number,
  ): Promise<void> {
    const timestamp = new Date();

    // Hot tier: both operations are fast Redis writes. The GEO set supports
    // future radius searches while the hash stores the complete latest point.
    await redisClient.geoAdd(liveGeoKey(tenantId), {
      longitude: lng,
      latitude: lat,
      member: driverId,
    });
    await redisClient.hSet(liveHashKey(tenantId, driverId), {
      tenantId,
      orderId,
      lat: lat.toString(),
      lng: lng.toString(),
      timestamp: timestamp.getTime().toString(),
    });

    // Cold tier: this append-only history does not burden PostgreSQL. A future
    // production worker can replace this with buffered insertMany batches.
    await LocationHistory.create({
      tenantId,
      driverId,
      orderId,
      coordinates: { lat, lng },
      timestamp,
    });
  }

  async getLiveLocation(
    tenantId: string,
    driverId: string,
  ): Promise<LiveLocation | null> {
    const data = await redisClient.hGetAll(liveHashKey(tenantId, driverId));
    if (!data.lat || !data.lng || !data.timestamp || !data.orderId) return null;

    return {
      tenantId,
      orderId: data.orderId,
      lat: Number.parseFloat(data.lat),
      lng: Number.parseFloat(data.lng),
      timestamp: new Date(Number.parseInt(data.timestamp, 10)),
    };
  }

  async getOrderHistory(tenantId: string, orderId: string) {
    return LocationHistory.find({ tenantId, orderId })
      .sort({ timestamp: 1 })
      .lean();
  }
}

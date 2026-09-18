import { Schema, model, type InferSchemaType } from "mongoose";

const LocationHistorySchema = new Schema(
  {
    tenantId: { type: String, required: true, index: true },
    driverId: { type: String, required: true, index: true },
    orderId: { type: String, required: true, index: true },
    coordinates: {
      lat: { type: Number, required: true },
      lng: { type: Number, required: true },
    },
    timestamp: { type: Date, default: Date.now, index: true },
  },
  { versionKey: false },
);

// The common history query is: one order, in chronological order.
LocationHistorySchema.index({ orderId: 1, timestamp: 1 });
LocationHistorySchema.index({ tenantId: 1, orderId: 1, timestamp: 1 });

export type LocationHistoryDocument = InferSchemaType<typeof LocationHistorySchema>;
export const LocationHistory = model<LocationHistoryDocument>(
  "LocationHistory",
  LocationHistorySchema,
);

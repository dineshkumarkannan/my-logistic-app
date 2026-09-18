import { EventEmitter } from "node:events";

export interface OrderStatusUpdatedEvent {
  tenantId: string;
  orderId: string;
  status: string;
  driverId?: string;
  customerId: string;
}

export const globalEventBus = new EventEmitter();

// The event bus is shared by application modules and may gain more listeners
// as new asynchronous subsystems are added.
globalEventBus.setMaxListeners(50);

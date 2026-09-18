import {
  globalEventBus,
  type OrderStatusUpdatedEvent,
} from "../../../config/eventBus.js";
import { getCorrelationId } from "../../../middlewares/trace.middleware.js";
import { logger } from "../../../utils/logger.js";
import {
  NotificationQueueService,
  type NotificationJobData,
} from "../services/notification.queue.js";

const queueService = new NotificationQueueService();
let removeListener: (() => void) | undefined;

const enqueueOrderNotifications = async (
  payload: OrderStatusUpdatedEvent,
): Promise<void> => {
  logger.info(
    { orderId: payload.orderId, status: payload.status },
    "Notification subsystem intercepted order state change.",
  );

  const tasks: Array<{
    name: string;
    data: NotificationJobData;
  }> = [
    {
      name: "send_customer_alert",
      data: {
        recipientId: payload.customerId,
        title: "Package Delivery Update",
        body: `Your logistics order status has transitioned to: ${payload.status.replaceAll("_", " ")}.`,
        channel: "EMAIL",
        correlationId: getCorrelationId(),
      },
    },
  ];

  if (payload.status === "ASSIGNED" && payload.driverId) {
    tasks.push({
      name: "send_driver_dispatch",
      data: {
        recipientId: payload.driverId,
        title: "New Delivery Run Assigned",
        body: "A new high-priority logistics route has been allocated to your profile dashboard.",
        channel: "PUSH",
        correlationId: getCorrelationId(),
      },
    });
  }

  await Promise.all(
    tasks.map((task) => queueService.dispatchNotificationTask(task.name, task.data)),
  );

  logger.info(
    { orderId: payload.orderId, jobCount: tasks.length },
    "Notification tasks queued.",
  );
};

export const initOrderEventsListener = (): void => {
  if (removeListener) {
    return;
  }

  const listener = (payload: OrderStatusUpdatedEvent): void => {
    // EventEmitter does not await async listeners. This deliberately keeps the
    // order request independent from Redis/BullMQ availability.
    void enqueueOrderNotifications(payload).catch((error: unknown) => {
      logger.error(
        { err: error, orderId: payload.orderId },
        "Notification enqueue failed.",
      );
    });
  };

  globalEventBus.on("order.status.updated", listener);
  removeListener = () => {
    globalEventBus.off("order.status.updated", listener);
    removeListener = undefined;
  };
};

export const shutdownOrderEventsListener = (): void => {
  removeListener?.();
};

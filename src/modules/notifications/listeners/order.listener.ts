import {
  globalEventBus,
  type OrderStatusUpdatedEvent,
} from "../../../config/eventBus.js";
import {
  NotificationQueueService,
  type NotificationJobData,
} from "../services/notification.queue.js";

const queueService = new NotificationQueueService();
let removeListener: (() => void) | undefined;

const enqueueOrderNotifications = async (
  payload: OrderStatusUpdatedEvent,
): Promise<void> => {
  console.log(
    `Notification subsystem intercepted state change for order ${payload.orderId}.`,
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
      },
    });
  }

  await Promise.all(
    tasks.map((task) => queueService.dispatchNotificationTask(task.name, task.data)),
  );

  console.log(
    `Queued ${tasks.length} notification task(s) for order ${payload.orderId}.`,
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
      console.error(
        `Notification enqueue failed for order ${payload.orderId}.`,
        error,
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

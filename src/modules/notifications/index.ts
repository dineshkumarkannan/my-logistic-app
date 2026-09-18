import type { Worker } from "bullmq";
import { initOrderEventsListener, shutdownOrderEventsListener } from "./listeners/order.listener.js";
import { startNotificationWorker } from "./jobs/notification.processor.js";
import { closeNotificationQueue } from "./services/notification.queue.js";
import type { NotificationJobData } from "./services/notification.queue.js";

let notificationWorker: Worker<NotificationJobData> | undefined;

export const bootstrapNotificationsModule = (): void => {
  initOrderEventsListener();
  notificationWorker ??= startNotificationWorker();
  console.log("Event-driven notification queue and worker online.");
};

export const shutdownNotificationsModule = async (): Promise<void> => {
  shutdownOrderEventsListener();

  if (notificationWorker) {
    await notificationWorker.close();
    notificationWorker = undefined;
  }

  await closeNotificationQueue();
};

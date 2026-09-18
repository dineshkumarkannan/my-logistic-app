import { Job, Worker } from "bullmq";
import { env } from "../../../config/environment.js";
import {
  NOTIFICATION_QUEUE_NAME,
  type NotificationJobData,
} from "../services/notification.queue.js";

const simulateExternalNotification = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 1_200));

  // This simulated fault makes BullMQ's retry and exponential backoff
  // behavior observable during local verification.
  if (Math.random() < 0.1) {
    throw new Error("Simulated third-party notification timeout.");
  }
};

export const startNotificationWorker = (): Worker<NotificationJobData> => {
  const worker = new Worker<NotificationJobData>(
    NOTIFICATION_QUEUE_NAME,
    async (job: Job<NotificationJobData>) => {
      const { recipientId, title, body, channel } = job.data;

      console.log(
        `[WORKER] Processing ${job.name} (ID: ${job.id}) via ${channel}.`,
      );

      // Keep the mock variables visible for the future SendGrid/Twilio/FCM
      // adapter without making external network calls in local development.
      void title;
      void body;
      await simulateExternalNotification();

      console.log(
        `[WORKER] Notification delivered to ${recipientId} via ${channel}.`,
      );
    },
    {
      connection: { url: env.REDIS_URL },
      concurrency: 5,
    },
  );

  worker.on("failed", (job, error) => {
    console.error(
      `[WORKER FAILED] Job ID: ${job?.id ?? "unknown"} failed: ${error.message}. BullMQ will retry automatically when attempts remain.`,
    );
  });

  worker.on("error", (error) => {
    console.error("[WORKER ERROR] Notification worker connection error.", error);
  });

  return worker;
};

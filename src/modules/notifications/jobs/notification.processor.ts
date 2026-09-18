import { Job, Worker } from "bullmq";
import { env } from "../../../config/environment.js";
import { logger } from "../../../utils/logger.js";
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

      logger.info(
        {
          correlationId: job.data.correlationId,
          jobName: job.name,
          jobId: job.id,
          channel,
        },
        "Notification job processing.",
      );

      // Keep the mock variables visible for the future SendGrid/Twilio/FCM
      // adapter without making external network calls in local development.
      void title;
      void body;
      await simulateExternalNotification();

      logger.info(
        { correlationId: job.data.correlationId, recipientId, channel },
        "Notification delivered.",
      );
    },
    {
      connection: { url: env.REDIS_URL },
      concurrency: 5,
    },
  );

  worker.on("failed", (job, error) => {
    logger.error(
      {
        err: error,
        correlationId: job?.data.correlationId,
        jobId: job?.id,
      },
      "Notification job failed; BullMQ will retry when attempts remain.",
    );
  });

  worker.on("error", (error) => {
    logger.error({ err: error }, "Notification worker connection error.");
  });

  return worker;
};

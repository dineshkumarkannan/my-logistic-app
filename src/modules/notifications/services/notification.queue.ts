import { Queue } from "bullmq";
import { env } from "../../../config/environment.js";

export const NOTIFICATION_QUEUE_NAME = "enterprise_notifications";

export type NotificationChannel = "EMAIL" | "SMS" | "PUSH";

export interface NotificationJobData {
  recipientId: string;
  title: string;
  body: string;
  channel: NotificationChannel;
  correlationId?: string;
}

export const notificationQueue = new Queue<NotificationJobData>(
  NOTIFICATION_QUEUE_NAME,
  {
    connection: { url: env.REDIS_URL },
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 5_000,
      },
      removeOnComplete: true,
      removeOnFail: false,
    },
  },
);

export class NotificationQueueService {
  async dispatchNotificationTask(
    jobName: string,
    data: NotificationJobData,
  ): Promise<void> {
    await notificationQueue.add(jobName, data);
  }
}

export const closeNotificationQueue = async (): Promise<void> => {
  await notificationQueue.close();
};

import { Queue } from "bullmq";
import { redisConnectionQueue } from "@shared/config/redis";

export type EventReportGenerationJobData = {
  reportId: string;
  epcId: string;
};

export const eventReportGenerationQueue =
  new Queue<EventReportGenerationJobData>("event-report-generation", {
    connection: redisConnectionQueue,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: { age: 60 * 60 * 24 },
      removeOnFail: { age: 60 * 60 * 24 * 7 },
    },
  });

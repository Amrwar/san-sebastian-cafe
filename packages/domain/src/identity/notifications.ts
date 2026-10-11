export const NOTIFICATION_CHANNELS = ["email", "push", "sms"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

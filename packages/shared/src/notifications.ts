import { z } from "zod";
import { SEVERITIES, type Severity } from "./alarms";

/**
 * Where alarms are sent (ADR 0001, decision 9). Recipients belong to the organization.
 * Expo push arrives with the mobile app; the dispatcher already treats channels as interchangeable.
 */
export const TARGET_KINDS = ["line", "email"] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export const NOTIFY_LIMITS = {
  repeatMinutes: { min: 5, max: 24 * 60 },
  maxReminders: { min: 1, max: 10 },
  linkCodeMinutes: 30,
  maxTargetsPerOrg: 50,
} as const;

/** A LINE user, group or room id as the Messaging API gives it. */
export const LINE_ID = /^[UCR][0-9a-f]{32}$/;

export interface NotificationTarget {
  id: string;
  kind: TargetKind;
  name: string;
  /** Email address, or LINE id. null = LINE recipient still waiting for its link code. */
  address: string | null;
  minSeverity: Severity;
  enabled: boolean;
  linkCode: string | null;
  linkExpiresAt: number | null;
  lastSentAt: number | null;
  lastError: string | null;
}

export interface NotificationSettings {
  /** Remind every N minutes until someone acknowledges; null = never remind. */
  repeatMinutes: number | null;
  maxReminders: number;
}

export interface ChannelStatus {
  line: boolean;
  lineWebhook: boolean;
  email: boolean;
}

export interface NotificationsResponse {
  settings: NotificationSettings;
  targets: NotificationTarget[];
  channels: ChannelStatus;
}

const name = z.string().trim().min(1).max(60);
const minSeverity = z.enum(SEVERITIES).default("warning");

export const createTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("email"), name, address: z.string().trim().toLowerCase().email().max(254), minSeverity }),
  z.object({
    kind: z.literal("line"),
    name,
    /** Optional: paste an id directly; otherwise a link code is issued. */
    address: z.string().trim().regex(LINE_ID, "LINE id must look like U followed by 32 hex characters").optional(),
    minSeverity,
  }),
]);
export type CreateTargetInput = z.input<typeof createTargetSchema>;

export const updateTargetSchema = z
  .object({ name: name.optional(), minSeverity: z.enum(SEVERITIES).optional(), enabled: z.boolean().optional() })
  .refine((b) => Object.values(b).some((v) => v !== undefined), "Nothing to change.");
export type UpdateTargetInput = z.infer<typeof updateTargetSchema>;

export const notificationSettingsSchema = z.object({
  repeatMinutes: z.number().int().min(NOTIFY_LIMITS.repeatMinutes.min).max(NOTIFY_LIMITS.repeatMinutes.max).nullable(),
  maxReminders: z.number().int().min(NOTIFY_LIMITS.maxReminders.min).max(NOTIFY_LIMITS.maxReminders.max),
});

/** Does a target with this threshold receive an alarm of that severity? */
export function targetWants(minSeverityOfTarget: Severity, alarm: Severity): boolean {
  return minSeverityOfTarget === "warning" || alarm === "critical";
}

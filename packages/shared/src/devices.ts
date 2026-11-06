import { z } from "zod";

/** Offline alarm threshold (ADR 0001, decision 8). null = no offline alarm for this device. */
export const OFFLINE_ALARM_LIMITS = { minSec: 120, maxSec: 24 * 60 * 60, defaultSec: 15 * 60 } as const;

export const createDeviceSchema = z.object({
  orgId: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  code: z.string().trim().regex(/^[A-Za-z0-9_-]{3,32}$/).optional(),
});
export type CreateDeviceInput = z.infer<typeof createDeviceSchema>;

export const updateDeviceSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    offlineAfterSec: z.number().int().min(OFFLINE_ALARM_LIMITS.minSec).max(OFFLINE_ALARM_LIMITS.maxSec).nullable().optional(),
  })
  .refine((b) => b.name !== undefined || b.offlineAfterSec !== undefined, "Nothing to change.");
export type UpdateDeviceInput = z.infer<typeof updateDeviceSchema>;

export interface ResetSecretResponse {
  /** Shown once. */
  secret: string;
}

import { z } from "zod";

/** How a metric is shown. Stored per device (the old system let users name channels and set units). */
export interface MetricSetting {
  label: string;
  unit: string;
  decimals: number;
  sortOrder: number;
  hidden: boolean;
}

const DEFAULTS: Record<string, Omit<MetricSetting, "hidden">> = {
  temperature: { label: "อุณหภูมิ", unit: "°C", decimals: 1, sortOrder: 0 },
  humidity: { label: "ความชื้น", unit: "%", decimals: 0, sortOrder: 1 },
};

/** The device's own setting if there is one, otherwise a sensible default for the key. */
export function metricMeta(settings: Record<string, MetricSetting> | undefined, key: string): MetricSetting {
  return settings?.[key] ?? { ...(DEFAULTS[key] ?? { label: key.replace(/_/g, " "), unit: "", decimals: 2, sortOrder: 100 }), hidden: false };
}

export function formatMetric(settings: Record<string, MetricSetting> | undefined, key: string, value: number): string {
  const m = metricMeta(settings, key);
  return `${value.toFixed(m.decimals)}${m.unit ? ` ${m.unit}` : ""}`;
}

/** Visible metrics in display order: sort order, then key. */
export function orderedMetrics(settings: Record<string, MetricSetting> | undefined, keys: string[], includeHidden = false): string[] {
  return [...new Set(keys)]
    .filter((k) => includeHidden || !metricMeta(settings, k).hidden)
    .sort((a, b) => metricMeta(settings, a).sortOrder - metricMeta(settings, b).sortOrder || a.localeCompare(b));
}

export const metricSettingsSchema = z.object({
  metrics: z
    .array(
      z.object({
        metric: z.string().regex(/^[a-z][a-z0-9_]{0,47}$/),
        label: z.string().trim().min(1).max(60),
        unit: z.string().trim().max(16).default(""),
        decimals: z.number().int().min(0).max(4),
        sortOrder: z.number().int().min(0).max(10_000),
        hidden: z.boolean().default(false),
      }),
    )
    .max(64),
});
export type MetricSettingsInput = z.input<typeof metricSettingsSchema>;

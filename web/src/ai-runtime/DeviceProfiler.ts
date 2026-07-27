import type { DeviceTier } from "./ModelTaskTypes";

export type DeviceProfile = {
  tier: DeviceTier;
  webGpu: boolean;
  memoryGb: number | null;
  logicalProcessors: number;
  mobile: boolean;
  cacheQuotaBytes: number | null;
  cacheUsageBytes: number | null;
  benchmarkMilliseconds: number;
  measuredAt: number;
};

const PROFILE_CACHE_KEY = "its-ai-device-profile:v3";
const PROFILE_TTL = 24 * 60 * 60 * 1000;

function safeStoredProfile(): DeviceProfile | null {
  try {
    const value = JSON.parse(localStorage.getItem(PROFILE_CACHE_KEY) || "null") as DeviceProfile | null;
    if (!value || Date.now() - value.measuredAt > PROFILE_TTL) return null;
    return value;
  } catch {
    return null;
  }
}

function benchmarkCpu(): number {
  const started = performance.now();
  let accumulator = 0;
  for (let index = 1; index <= 45_000; index += 1) {
    accumulator += Math.sin(index) * Math.cos(index / 3);
  }
  if (!Number.isFinite(accumulator)) return Number.POSITIVE_INFINITY;
  return Math.max(0.1, performance.now() - started);
}

async function hasUsableWebGpu(): Promise<boolean> {
  const nav = navigator as Navigator & {
    gpu?: { requestAdapter: (options?: { powerPreference?: "low-power" | "high-performance" }) => Promise<unknown | null> };
  };
  if (!nav.gpu?.requestAdapter) return false;
  try {
    const adapter = await Promise.race([
      nav.gpu.requestAdapter({ powerPreference: "high-performance" }),
      new Promise<null>((resolve) => window.setTimeout(() => resolve(null), 2_500)),
    ]);
    return Boolean(adapter);
  } catch {
    return false;
  }
}

function classifyTier(
  webGpu: boolean,
  memoryGb: number | null,
  processors: number,
  mobile: boolean,
  benchmarkMilliseconds: number,
): DeviceTier {
  if (!webGpu || mobile || (memoryGb != null && memoryGb <= 4) || processors <= 4 || benchmarkMilliseconds > 34) {
    return "LOW";
  }
  if ((memoryGb ?? 8) >= 12 && processors >= 8 && benchmarkMilliseconds < 16) return "HIGH";
  return "MEDIUM";
}

export class DeviceProfiler {
  private current: Promise<DeviceProfile> | null = null;

  async profile(force = false): Promise<DeviceProfile> {
    if (!force) {
      const cached = safeStoredProfile();
      if (cached) return cached;
    }
    if (this.current && !force) return this.current;
    this.current = this.measure();
    try {
      return await this.current;
    } finally {
      this.current = null;
    }
  }

  private async measure(): Promise<DeviceProfile> {
    const nav = navigator as Navigator & { deviceMemory?: number; userAgentData?: { mobile?: boolean } };
    const webGpu = await hasUsableWebGpu();
    const memoryGb = Number.isFinite(nav.deviceMemory) ? Number(nav.deviceMemory) : null;
    const logicalProcessors = Math.max(1, navigator.hardwareConcurrency || 1);
    const mobile = nav.userAgentData?.mobile === true || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
    const estimate: StorageEstimate = navigator.storage?.estimate
      ? await navigator.storage.estimate().catch(() => ({} as StorageEstimate))
      : {};
    const benchmarkMilliseconds = benchmarkCpu();
    const result: DeviceProfile = {
      tier: classifyTier(webGpu, memoryGb, logicalProcessors, mobile, benchmarkMilliseconds),
      webGpu,
      memoryGb,
      logicalProcessors,
      mobile,
      cacheQuotaBytes: Number.isFinite(estimate.quota) ? Number(estimate.quota) : null,
      cacheUsageBytes: Number.isFinite(estimate.usage) ? Number(estimate.usage) : null,
      benchmarkMilliseconds,
      measuredAt: Date.now(),
    };
    try {
      localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(result));
    } catch {
      // Profiling remains usable when storage is disabled.
    }
    return result;
  }
}

export const deviceProfiler = new DeviceProfiler();

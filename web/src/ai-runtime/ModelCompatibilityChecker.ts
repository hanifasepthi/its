import type { DeviceProfile } from "./DeviceProfiler";
import type { ModelCandidate } from "./ModelTaskTypes";

export type ModelCompatibility = {
  compatible: boolean;
  issues: string[];
  warnings: string[];
};

function maximumParameters(profile: DeviceProfile): number {
  if (profile.tier === "HIGH") return 4;
  if (profile.tier === "MEDIUM") return 2;
  return 0.8;
}

export class ModelCompatibilityChecker {
  check(candidate: ModelCandidate, profile: DeviceProfile): ModelCompatibility {
    const issues: string[] = [];
    const warnings: string[] = [];
    if (!candidate.public) issues.push("model-private");
    if (candidate.gated) issues.push("model-gated");
    if (!candidate.hasOnnx) issues.push("onnx-missing");
    if (!candidate.transformersJs) issues.push("transformers-js-unsupported");
    if (candidate.requiresRemoteCode) issues.push("remote-code-required");
    if (!candidate.license || candidate.license === "unknown") issues.push("license-missing");
    if (candidate.parameterBillions > maximumParameters(profile)) issues.push("device-memory-budget-exceeded");
    const cacheQuota = profile.cacheQuotaBytes || 2_000_000_000;
    if (candidate.estimatedBytes > cacheQuota * 0.7) warnings.push("large-cache-footprint");
    if (!profile.webGpu && !candidate.quantizations.some((value) => value === "q4" || value === "q8")) warnings.push("wasm-without-quantization");
    return { compatible: issues.length === 0, issues, warnings };
  }
}

export const modelCompatibilityChecker = new ModelCompatibilityChecker();

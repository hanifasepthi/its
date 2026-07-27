import type { AgentRequestedAction } from "./AgentPlanSchema";

export type AgentSecurityDecision = {
  allowed: boolean;
  reason: string;
};

export class AgentSecurityPolicy {
  allowUrl(value: string): AgentSecurityDecision {
    try {
      const url = new URL(value, window.location.href);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        return { allowed: false, reason: `Protocol '${url.protocol}' tidak diizinkan.` };
      }
      if (url.username || url.password) {
        return { allowed: false, reason: "URL dengan credential tertanam ditolak." };
      }
      return { allowed: true, reason: "URL publik HTTP(S)." };
    } catch {
      return { allowed: false, reason: "URL tidak valid." };
    }
  }

  allowAction(action: AgentRequestedAction, planNeedsLocation: boolean): AgentSecurityDecision {
    if (!action.type.trim()) return { allowed: false, reason: "Action type kosong." };
    if (action.type === "resolve_location" && !planNeedsLocation) {
      return { allowed: false, reason: "Plan tidak meminta akses lokasi." };
    }
    return { allowed: true, reason: "Action akan dijalankan melalui adapter aplikasi terbatas." };
  }
}

export const agentSecurityPolicy = new AgentSecurityPolicy();

import { HttpError } from "./http";
import type { Env } from "./types";

type BudgetState = {
  day: string;
  executions: number;
};

export class AiBudget {
  constructor(private readonly state: DurableObjectState, private readonly env: Env) {}

  async fetch(_request: Request): Promise<Response> {
    const day = new Date().toISOString().slice(0, 10);
    const maximum = Math.max(10, Math.min(1_000, Number(this.env.AI_DAILY_EXECUTION_LIMIT || 250) || 250));
    let executions = 0;
    let accepted = false;
    await this.state.storage.transaction(async (transaction) => {
      const previous = await transaction.get<BudgetState>("current");
      executions = previous?.day === day ? previous.executions : 0;
      if (executions >= maximum) return;
      executions += 1;
      accepted = true;
      await transaction.put("current", { day, executions } satisfies BudgetState);
    });
    return Response.json(
      { ok: accepted, day, executions, limit: maximum },
      { status: accepted ? 200 : 429, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export async function enforceAiDailyBudget(env: Env): Promise<void> {
  const id = env.AI_BUDGET.idFromName("its-maps-global-ai-budget");
  const response = await env.AI_BUDGET.get(id).fetch("https://ai-budget.internal/consume", { method: "POST" });
  if (response.status === 429) {
    throw new HttpError(429, "ai_daily_budget_exhausted", "Batas harian AI cloud tercapai; gunakan fallback AI lokal.");
  }
  if (!response.ok) throw new HttpError(503, "ai_budget_unavailable", "Pengaman kuota AI cloud sementara tidak tersedia.");
}

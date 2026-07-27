import { modelResolver } from "./ModelResolver";
import type { ResearchPlan, ResearchTurn } from "../research/ResearchTypes";

export type AssistantReasoningInput = {
  question: string;
  plan: ResearchPlan;
  history: ResearchTurn[];
  realtimeContext?: Record<string, unknown>;
  applicationContext?: Record<string, unknown>;
  signal?: AbortSignal;
  onProgress?: (message: string, progress?: number) => void;
};

function messages(input: AssistantReasoningInput): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const recentHistory = input.history.slice(-8);
  return [
    {
      role: "system",
      content: [
        "Anda adalah Asisten ITS Maps berbahasa Indonesia.",
        "Jawab maksud pengguna secara natural, langsung, dan tidak seperti menu atau template.",
        "Gunakan hanya fakta dalam konteks yang diberikan. Jangan mengarang identitas, angka, lokasi, status, sumber, atau kemampuan aplikasi.",
        "Jangan menyebut nama model internal. Jangan menambahkan data RTDB bila tidak relevan dengan pertanyaan.",
        "Jika konteks tidak cukup, nyatakan informasi apa yang belum tersedia dengan singkat.",
        "Untuk riset atau formula bersumber, jangan menjawab sendiri karena ResearchOrchestrator yang menanganinya.",
      ].join("\n"),
    },
    {
      role: "user",
      content: JSON.stringify({
        question: input.question,
        plan: input.plan,
        recentHistory,
        realtimeContext: input.plan.needsRealtime ? input.realtimeContext || null : null,
        applicationContext: input.applicationContext || null,
      }),
    },
  ];
}

export class AssistantReasoner {
  async answer(input: AssistantReasoningInput): Promise<string> {
    input.onProgress?.("Model bahasa menyusun jawaban dari konteks yang tersedia", 58);
    const model = await modelResolver.resolve("follow-up-reasoning");
    return model.generateText(messages(input), {
      maxNewTokens: 360,
      temperature: 0.25,
      doSample: true,
      repetitionPenalty: 1.08,
      timeoutMs: 180_000,
      signal: input.signal,
      onProgress: input.onProgress,
    });
  }
}

export const assistantReasoner = new AssistantReasoner();

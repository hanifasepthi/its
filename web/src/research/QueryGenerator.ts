import { modelResolver } from "../ai-runtime/ModelResolver";
import { deviceProfiler } from "../ai-runtime/DeviceProfiler";
import {
  compactResearchTopic,
  entityText,
  researchAspectTerms,
  sharedTechnicalTerms,
  technicalAnchors,
} from "./ResearchText";
import type {
  ResearchPlan,
  ResearchQueryKind,
  ResearchQuerySpec,
  ResearchTurn,
} from "./ResearchTypes";

export type ResearchQuery = ResearchQuerySpec;

type QueryEnvelope = { queries: ResearchQuery[] };

const QUERY_KINDS = new Set<ResearchQueryKind>([
  "broad",
  "exact",
  "official",
  "open-access",
  "document",
  "image",
  "comparison",
]);

function isQueryEnvelope(value: unknown): value is QueryEnvelope {
  if (!value || typeof value !== "object") return false;
  const queries = (value as { queries?: unknown }).queries;
  return Array.isArray(queries) && queries.every((query) => {
    if (!query || typeof query !== "object") return false;
    const item = query as Record<string, unknown>;
    return typeof item.id === "string"
      && typeof item.text === "string"
      && typeof item.kind === "string"
      && QUERY_KINDS.has(item.kind as ResearchQueryKind)
      && Array.isArray(item.sourceTypes)
      && item.sourceTypes.every((sourceType) => typeof sourceType === "string");
  });
}

function uniqueQueries(queries: ResearchQuery[]): ResearchQuery[] {
  const seen = new Set<string>();
  return queries.filter((query) => {
    const normalized = query.text.trim().toLocaleLowerCase();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  }).map((query, index) => ({
    ...query,
    id: query.id.trim() || `query-${index + 1}`,
    text: query.text.trim(),
    sourceTypes: [...new Set(query.sourceTypes.map((value) => value.trim()).filter(Boolean))].slice(0, 8),
  })).slice(0, 7);
}

function neutralFallback(plan: ResearchPlan, question: string): ResearchQuery[] {
  const entities = plan.entities || [];
  const entityValues = entities.map(entityText).filter(Boolean);
  // Technical names from the actual wording receive their own exact query
  // before a planner-provided entity that may combine several names.
  const anchors = [...new Set([...technicalAnchors(question), ...entityValues])].slice(0, 6);
  const topic = compactResearchTopic(question, entities);
  const sourceTypes = plan.domainProfile?.requiredSourceTypes || [];
  const queries: ResearchQuery[] = [{ id: "query-broad", kind: "broad", text: topic, sourceTypes }];
  if (anchors.length >= 2 && /\b(?:bandingkan|perbandingan|compare|comparison|versus|vs\.?|beda|difference)\b/i.test(question)) {
    queries.push({ id: "query-comparison", kind: "comparison", text: `${anchors[0]} ${anchors[1]} comparison`, sourceTypes });
  }
  const aspects = researchAspectTerms(question);
  if (aspects.length) {
    const family = sharedTechnicalTerms(technicalAnchors(question));
    const subject = family.length ? family.join(" ") : anchors.slice(0, 2).join(" ");
    const contextTerms = aspects.filter((term) => /end-to-end|object detection/i.test(term));
    const matchingTerms = aspects.filter((term) => /matching|assignment/i.test(term));
    const limitationTerms = aspects.filter((term) => /limitation|latency|cost/i.test(term));
    if (matchingTerms.length) {
      queries.push({
        id: "query-aspect-matching",
        kind: "open-access",
        text: `${subject} ${[...contextTerms, ...matchingTerms].join(" ")}`.trim(),
        sourceTypes,
      });
    }
    if (limitationTerms.length) {
      queries.push({
        id: "query-aspect-limitations",
        kind: "open-access",
        text: `${anchors.slice(0, 2).join(" ")} ${limitationTerms.join(" ")}`.trim(),
        sourceTypes,
      });
    }
    if (!matchingTerms.length && !limitationTerms.length) {
      queries.push({ id: "query-aspect", kind: "open-access", text: `${subject} ${aspects.slice(0, 6).join(" ")}`.trim(), sourceTypes });
    }
  }
  anchors.slice(0, 3).forEach((anchor, index) => {
    queries.push({ id: `query-exact-${index + 1}`, kind: "exact", text: anchor, sourceTypes });
  });
  if (plan.needsPdf) queries.push({ id: "query-document", kind: "document", text: `${topic} open access paper`, sourceTypes });
  if (plan.needsImages) queries.push({ id: "query-image", kind: "image", text: topic, sourceTypes: ["open licensed image", ...sourceTypes] });
  if (sourceTypes.some((value) => /official|government|standard|primary/i.test(value))) {
    queries.push({ id: "query-official", kind: "official", text: topic, sourceTypes });
  }
  return uniqueQueries(queries);
}

export class QueryGenerator {
  async generate(
    question: string,
    plan: ResearchPlan,
    history: ResearchTurn[] = [],
    signal?: AbortSignal,
    onProgress?: (message: string, progress?: number) => void,
  ): Promise<ResearchQuery[]> {
    try {
      const profile = await deviceProfiler.profile();
      if (!profile.webGpu) {
        onProgress?.("Menyusun query teknis ringan agar peta tetap responsif", 12);
        return neutralFallback(plan, question);
      }
      onProgress?.("Model membuat query retrieval dari rencana runtime", 12);
      const model = await modelResolver.resolve("query-generation");
      const envelope = await model.generateStructured(
        [
          {
            role: "system",
            content: [
              "Generate retrieval queries only; do not answer the question.",
              "Derive every query from the supplied question, plan, entities, domain profile, and conversation.",
              "Do not inject a fixed subject, person, place, formula, provider, or answer.",
              "Use only these query kinds: broad, exact, official, open-access, document, image, comparison.",
              "Return one JSON object with a queries array and no markdown.",
            ].join("\n"),
          },
          {
            role: "user",
            content: JSON.stringify({
              question,
              history: history.slice(-10),
              intent: plan.intent,
              domains: plan.domains,
              entities: plan.entities,
              goals: plan.goals,
              domainProfile: plan.domainProfile || null,
              requestedCapabilities: plan.requiredCapabilities,
              needsPdf: plan.needsPdf,
              needsImages: plan.needsImages,
            }),
          },
        ],
        isQueryEnvelope,
        {
          maxNewTokens: 520,
          temperature: 0.15,
          doSample: false,
          timeoutMs: 90_000,
          signal,
          onProgress,
        },
      );
      const queries = uniqueQueries(envelope.queries);
      return queries.length ? queries : neutralFallback(plan, question);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      console.warn("[ITS Research] Query generator unavailable; neutral query used", error);
      return neutralFallback(plan, question);
    }
  }
}

export const queryGenerator = new QueryGenerator();

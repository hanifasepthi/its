const RETRIEVAL_STOP_WORDS = new Set(`
  ada agar akan aku adalah anda apa apakah bagaimana bandingkan berdasarkan benar berikan berikut
  bisa buat dibuat cara dan dari data dengan detail di dibaca digunakan dijelaskan jelaskan jika juga
  karena ke kemudian lengkap lebih maka mana melalui meminta menurut merupakan pada paling perlu
  pertanyaan saat saya sebagai secara sebutkan sedang sertakan serta sumber supaya tentang terhadap
  tidak untuk yang
  a an and answer are as based be by can compare describe do does explain for from give how in include
  is it of on or please read show source sources than that the their this to use used versus what when
  where which who why with
`.trim().split(/\s+/));

function rawTokens(value: string): string[] {
  return value
    .normalize("NFKD")
    .match(/[\p{L}\p{N}]+(?:[-_.][\p{L}\p{N}]+)*/gu) || [];
}

export function retrievalTokens(value: string): string[] {
  return rawTokens(value)
    .map((token) => token.toLocaleLowerCase())
    .filter((token) => token.length > 1 && !RETRIEVAL_STOP_WORDS.has(token));
}

export function technicalAnchors(value: string): string[] {
  const seen = new Set<string>();
  return rawTokens(value).filter((token) => {
    const normalized = token.toLocaleLowerCase();
    if (seen.has(normalized)) return false;
    const parts = normalized.split(/[-_.]/).filter(Boolean);
    if (RETRIEVAL_STOP_WORDS.has(normalized)
      || (parts.length > 1 && parts.every((part) => RETRIEVAL_STOP_WORDS.has(part)))
      || (parts.length > 1 && new Set(parts).size === 1)) return false;
    const letters = token.replace(/[^A-Za-z]/g, "");
    const uppercase = letters.replace(/[^A-Z]/g, "").length;
    const looksTechnical = /[-_.]/.test(token)
      || /\d/.test(token)
      || (letters.length >= 2 && uppercase / letters.length >= 0.6);
    if (!looksTechnical) return false;
    seen.add(normalized);
    return true;
  });
}

export function entityText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  return typeof (value as { text?: unknown }).text === "string"
    ? (value as { text: string }).text.trim()
    : "";
}

const RESEARCH_ASPECT_EXPANSIONS: Array<{ pattern: RegExp; terms: string[] }> = [
  { pattern: /\b(?:deteksi|detection|detector)\b/i, terms: ["end-to-end", "object detection"] },
  { pattern: /\b(?:pencocokan|matching|assignment|korespondensi)\b/i, terms: ["bipartite matching", "Hungarian assignment"] },
  { pattern: /\b(?:prediksi|prediction|predict)\b/i, terms: ["prediction", "object queries", "targets"] },
  { pattern: /\b(?:keterbatasan|batasan|kelemahan|limitations?|drawbacks?)\b/i, terms: ["practical limitations", "latency", "computational cost"] },
  { pattern: /\b(?:prinsip|mekanisme|principles?|mechanism)\b/i, terms: ["principle", "mechanism"] },
  { pattern: /\b(?:lalu\s+lintas|traffic|kendaraan|vehicle)\b/i, terms: ["traffic", "vehicle"] },
];

export function researchAspectTerms(value: string): string[] {
  return [...new Set(RESEARCH_ASPECT_EXPANSIONS
    .filter((entry) => entry.pattern.test(value))
    .flatMap((entry) => entry.terms))];
}

export function sharedTechnicalTerms(anchors: string[]): string[] {
  const groups = anchors.map((anchor) => anchor.toLocaleLowerCase()
    .split(/[-_.\s]+/)
    .filter((part) => part.length > 2 && !RETRIEVAL_STOP_WORDS.has(part)));
  if (groups.length < 2) return [];
  return [...new Set(groups[0].filter((part) => groups.slice(1).every((group) => group.includes(part))))];
}

export function compactResearchTopic(question: string, entityValues: unknown[] = []): string {
  const entities = entityValues.map(entityText).filter(Boolean);
  const anchors = [...new Set([
    ...entities,
    ...technicalAnchors(question),
  ].map((value) => value.trim()).filter(Boolean))];
  if (anchors.length) return anchors.slice(0, 6).join(" ");
  return [...new Set(rawTokens(question)
    .filter((token) => !RETRIEVAL_STOP_WORDS.has(token.toLocaleLowerCase())))]
    .slice(0, 12)
    .join(" ") || question.trim().slice(0, 180);
}

export function anchorVariants(value: string): string[] {
  const anchors = technicalAnchors(value).map((token) => token.toLocaleLowerCase());
  const parts = anchors.flatMap((token) => token.split(/[-_.]/).filter((part) => part.length > 2));
  return [...new Set([...anchors, ...parts])];
}

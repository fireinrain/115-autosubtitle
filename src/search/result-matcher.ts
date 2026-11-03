import type { SubtitleSearchResult } from "../providers/provider";
import type { SubtitleSearchQuery } from "../providers/provider";

const CODE_MATCH_WEIGHT = 40;
const TITLE_SIMILARITY_WEIGHT = 15;
const DURATION_WEIGHT = 20;
const LANGUAGE_WEIGHT = 10;
const RELIABILITY_WEIGHT = 5;

export function scoreResult(result: SubtitleSearchResult, query: SubtitleSearchQuery): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  if (result.code && query.normalizedCode) {
    if (result.code.toUpperCase() === query.normalizedCode.toUpperCase()) {
      score += CODE_MATCH_WEIGHT;
      reasons.push("番号完全匹配");
    } else {
      score -= 30;
      reasons.push("番号不匹配");
    }
  }

  if (query.fileName && result.title) {
    const similarity = titleSimilarity(query.fileName, result.title);
    score += Math.round(similarity * TITLE_SIMILARITY_WEIGHT);
    if (similarity > 0.5) reasons.push("标题相似度高");
  }

  if (query.duration && result.duration) {
    const diff = Math.abs(query.duration - result.duration);
    if (diff < 5) {
      score += DURATION_WEIGHT;
      reasons.push("时长接近");
    } else if (diff < 30) {
      score += Math.round(DURATION_WEIGHT * 0.5);
      reasons.push("时长大致匹配");
    }
  }

  if (result.language && query.languagePreferences.length > 0) {
    const langIdx = query.languagePreferences.findIndex((l) =>
      result.language!.toLowerCase().includes(l.toLowerCase()),
    );
    if (langIdx === 0) {
      score += LANGUAGE_WEIGHT;
      reasons.push("首选语言");
    } else if (langIdx > 0) {
      score += Math.round(LANGUAGE_WEIGHT * 0.6);
      reasons.push("次选语言");
    }
  }

  if (result.rating) {
    score += Math.round((result.rating / 10) * RELIABILITY_WEIGHT);
  }

  score = Math.max(0, Math.min(100, score));
  return { score, reasons };
}

function titleSimilarity(a: string, b: string): number {
  const na = a.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, "");
  const nb = b.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, "");
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const longer = na.length >= nb.length ? na : nb;
  const shorter = na.length >= nb.length ? nb : na;
  if (longer.includes(shorter)) return shorter.length / longer.length;
  let common = 0;
  for (const ch of shorter) {
    if (longer.includes(ch)) common++;
  }
  return common / longer.length;
}

export function sortResults(results: SubtitleSearchResult[]): SubtitleSearchResult[] {
  return [...results].sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0));
}

export function deduplicateResults(results: SubtitleSearchResult[]): SubtitleSearchResult[] {
  const seen = new Set<string>();
  const out: SubtitleSearchResult[] = [];
  for (const r of results) {
    const key = `${r.providerId}:${r.sourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
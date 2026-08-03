export function readAnalysisExportMinimumEquivalenceClassSize(): number | null {
  const raw = process.env.ANALYSIS_EXPORT_MIN_EQUIVALENCE_CLASS_SIZE;
  if (!raw) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 2 ? value : null;
}

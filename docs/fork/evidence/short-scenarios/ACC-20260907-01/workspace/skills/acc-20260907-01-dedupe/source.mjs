export default async function run(params) {
  const items = params?.items;
  if (!Array.isArray(items)) {
    return [];
  }
  const seen = new Set();
  const result = [];
  for (const raw of items) {
    if (typeof raw !== "string") continue;
    const trimmed = raw.trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}
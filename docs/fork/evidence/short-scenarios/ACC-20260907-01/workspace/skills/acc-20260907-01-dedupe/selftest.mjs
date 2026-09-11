const readRes = await bridge("read", ["skills/acc-20260907-01-dedupe/source.mjs"]);
const raw = typeof readRes === "string" ? readRes : (readRes.content || readRes.projection.split("\n").slice(1).map(l => l.replace(/^\s*\d+\s+[a-z0-9]{2}\s{2}/, "")).join("\n"));
const fn = new Function(raw.replace("export default", "return"))();
const res = await fn({ items: [" a ", "b", "a", ""] });
if (!Array.isArray(res) || res.length !== 2 || res[0] !== "a" || res[1] !== "b") {
  throw new Error(`Assertion failed: expected ["a", "b"], got ${JSON.stringify(res)}`);
}
return true;
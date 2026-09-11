# Memory evaluation runbook

This runbook covers the P5 retrieval measurement. The pure metrics live in
`packages/memory-core/src/evaluation.ts`; the real local-model adapter is
`packages/stage-ui/src/services/memory/evaluate-chinese-memory.ts`.

The adapter is explicit because loading `Xenova/nomic-embed-text-v1` can fetch a
large model artifact. It must be run from the leader renderer after the user
has accepted that model load.

The fixture is stratified into nine groups. Each group contains ten judgments
and stores gold memory ids:

- short Chinese queries
- long Chinese paraphrases
- English queries against Chinese facts
- Chinese queries against English facts
- negation
- multiple facts
- temporal language
- unrelated long text
- near-miss facts

Record `recall@3`, MRR, `precision@3`, and false-positive rate per stratum.
When an adapter runs the dual-query path, also record query token count,
additional normalized-query token cost, and retrieval latency. Do not promote
a model or change production weights from the overall mean alone. A candidate
passes the first gate only when every required stratum has non-zero recall and
the unrelated and near-miss groups do not regress.

The production retrieval path keeps both the original and normalized query.
The normalized query is mechanical and must preserve negation clauses. The
evaluation adapter can compare one route with the merged result without
changing stored memories or production weights.

The evaluation output is measurement only. It does not change memory weights,
promotion thresholds, or stored memories.

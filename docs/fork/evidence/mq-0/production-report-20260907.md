# MQ-0 production memory retrieval report (2026-09-07)

This run used an isolated copy of the local Electron profile. It inserted the 20 synthetic approved gold facts from `gold-corpus.md` with their stable `originId` values, then called the production renderer retrieval path for all 90 cases.

Profile: local
Session: mq-0-production-20260907
Scope: userId=local, characterId=n8cz_qXFxNLwpJmuAsfIl

Cases: 90
Recall@3: 0.789
Precision@3: 0.263
MRR@3: 0.637
False-positive@3: 0.626
Average retrieval latency (ms): 1104.84
Query token usage: missing (90/90)
Additional normalized-query token usage: missing (90/90)
Cost: missing (90/90)

| Stratum | Cases | Recall@3 | Precision@3 | MRR@3 | False-positive@3 |
| --- | ---: | ---: | ---: | ---: | ---: |
| short-zh | 10 | 0.800 | 0.267 | 0.550 | 0.733 |
| long-zh | 10 | 1.000 | 0.333 | 0.950 | 0.667 |
| en-to-zh | 10 | 0.000 | 0.000 | 0.000 | 0.000 |
| zh-to-en | 10 | 0.800 | 0.267 | 0.650 | 0.733 |
| negation | 10 | 0.800 | 0.267 | 0.617 | 0.733 |
| multi-fact | 10 | 0.800 | 0.267 | 0.633 | 0.733 |
| temporal | 10 | 1.000 | 0.333 | 0.717 | 0.667 |
| unrelated-long | 10 | 1.000 | 0.333 | 1.000 | 0.667 |
| near-miss | 10 | 0.900 | 0.300 | 0.617 | 0.700 |

## False-positive cases

| Case | Stratum | False-positive ids |
| --- | --- | --- |
| short-zh-01 | short-zh | fact-appearance, fact-no-startup |
| short-zh-02 | short-zh | fact-no-startup, fact-appearance |
| short-zh-03 | short-zh | fact-no-study-abroad, fact-no-startup |
| short-zh-04 | short-zh | fact-no-startup, fact-appearance |
| short-zh-05 | short-zh | fact-unrelated-09, fact-unrelated-03, fact-unrelated-05 |
| short-zh-06 | short-zh | fact-no-appearance, fact-unrelated-06 |
| short-zh-07 | short-zh | fact-unrelated-09, fact-unrelated-03, fact-unrelated-05 |
| short-zh-08 | short-zh | fact-test-first, fact-unrelated-07 |
| short-zh-09 | short-zh | fact-no-work-avoidance, fact-unrelated-05 |
| short-zh-10 | short-zh | fact-unrelated-05, fact-unrelated-09 |
| long-zh-01 | long-zh | fact-unrelated-09, fact-unrelated-03 |
| long-zh-02 | long-zh | fact-no-study-abroad, fact-appearance |
| long-zh-03 | long-zh | fact-no-appearance, fact-unrelated-09 |
| long-zh-04 | long-zh | fact-protocol-first, fact-unrelated-03 |
| long-zh-05 | long-zh | fact-test-first, fact-unrelated-09 |
| long-zh-06 | long-zh | fact-no-work-avoidance, fact-no-study-abroad |
| long-zh-07 | long-zh | fact-unrelated-01, fact-no-study-abroad |
| long-zh-08 | long-zh | fact-study-abroad, fact-no-study-abroad |
| long-zh-09 | long-zh | fact-no-study-abroad, fact-no-startup |
| long-zh-10 | long-zh | fact-no-appearance, fact-unrelated-09 |
| zh-to-en-01 | zh-to-en | fact-appearance, fact-no-study-abroad |
| zh-to-en-02 | zh-to-en | fact-no-study-abroad, fact-appearance |
| zh-to-en-03 | zh-to-en | fact-no-appearance, fact-unrelated-09 |
| zh-to-en-04 | zh-to-en | fact-protocol-first, fact-unrelated-07 |
| zh-to-en-05 | zh-to-en | fact-test-first, fact-unrelated-02, fact-appearance |
| zh-to-en-06 | zh-to-en | fact-unrelated-01, fact-no-work-avoidance |
| zh-to-en-07 | zh-to-en | fact-unrelated-09, fact-unrelated-05, fact-unrelated-02 |
| zh-to-en-08 | zh-to-en | fact-no-startup, fact-appearance |
| zh-to-en-09 | zh-to-en | fact-no-study-abroad, fact-no-startup |
| zh-to-en-10 | zh-to-en | fact-no-appearance, fact-unrelated-06 |
| negation-01 | negation | fact-protocol-first, fact-study-abroad |
| negation-02 | negation | fact-study-abroad, fact-no-startup |
| negation-03 | negation | fact-protocol-first, fact-no-startup |
| negation-04 | negation | fact-no-appearance, fact-no-startup |
| negation-05 | negation | fact-unrelated-09, fact-unrelated-05 |
| negation-06 | negation | fact-no-startup, fact-appearance |
| negation-07 | negation | fact-test-first, fact-unrelated-07 |
| negation-08 | negation | fact-unrelated-01, fact-no-study-abroad, fact-unrelated-09 |
| negation-09 | negation | fact-no-startup, fact-appearance |
| negation-10 | negation | fact-unrelated-09, fact-no-startup, fact-unrelated-05 |
| multi-fact-01 | multi-fact | fact-no-study-abroad, fact-study-abroad |
| multi-fact-02 | multi-fact | fact-no-study-abroad, fact-appearance |
| multi-fact-03 | multi-fact | fact-protocol-first, fact-unrelated-07 |
| multi-fact-04 | multi-fact | fact-no-startup, fact-no-work-avoidance, fact-unrelated-09 |
| multi-fact-05 | multi-fact | fact-no-work-avoidance, fact-unrelated-01 |
| multi-fact-06 | multi-fact | fact-study-abroad, fact-no-study-abroad |
| multi-fact-07 | multi-fact | fact-test-first, fact-unrelated-07 |
| multi-fact-08 | multi-fact | fact-no-appearance, fact-no-study-abroad |
| multi-fact-09 | multi-fact | fact-study-abroad, fact-appearance |
| multi-fact-10 | multi-fact | fact-no-work-avoidance, fact-work-avoidance, fact-unrelated-01 |
| temporal-01 | temporal | fact-no-startup, fact-appearance |
| temporal-02 | temporal | fact-no-study-abroad, fact-no-startup |
| temporal-03 | temporal | fact-no-appearance, fact-unrelated-06 |
| temporal-04 | temporal | fact-protocol-first, fact-unrelated-07 |
| temporal-05 | temporal | fact-test-first, fact-unrelated-07 |
| temporal-06 | temporal | fact-no-work-avoidance, fact-unrelated-05 |
| temporal-07 | temporal | fact-protocol-first, fact-test-first |
| temporal-08 | temporal | fact-no-startup, fact-study-abroad |
| temporal-09 | temporal | fact-no-startup, fact-no-study-abroad |
| temporal-10 | temporal | fact-no-appearance, fact-test-first |
| unrelated-long-01 | unrelated-long | fact-unrelated-09, fact-no-startup |
| unrelated-long-02 | unrelated-long | fact-no-appearance, fact-test-first |
| unrelated-long-03 | unrelated-long | fact-unrelated-08, fact-unrelated-09 |
| unrelated-long-04 | unrelated-long | fact-study-abroad, fact-unrelated-02 |
| unrelated-long-05 | unrelated-long | fact-unrelated-07, fact-unrelated-03 |
| unrelated-long-06 | unrelated-long | fact-unrelated-01, fact-appearance |
| unrelated-long-07 | unrelated-long | fact-test-first, fact-no-study-abroad |
| unrelated-long-08 | unrelated-long | fact-unrelated-03, fact-unrelated-10 |
| unrelated-long-09 | unrelated-long | fact-unrelated-03, fact-unrelated-01 |
| unrelated-long-10 | unrelated-long | fact-unrelated-08, fact-protocol-first |
| near-miss-01 | near-miss | fact-no-startup, fact-appearance |
| near-miss-02 | near-miss | fact-unrelated-07, fact-study-abroad |
| near-miss-03 | near-miss | fact-test-first, fact-unrelated-03 |
| near-miss-04 | near-miss | fact-unrelated-09, fact-unrelated-03, fact-no-startup |
| near-miss-05 | near-miss | fact-work-avoidance, fact-protocol-first |
| near-miss-06 | near-miss | fact-no-appearance, fact-appearance |
| near-miss-07 | near-miss | fact-appearance, fact-unrelated-10 |
| near-miss-08 | near-miss | fact-no-startup, fact-scholarship |
| near-miss-09 | near-miss | fact-protocol-first, fact-no-startup |
| near-miss-10 | near-miss | fact-appearance, fact-unrelated-06 |

The local embedding worker did not report token usage, so token and cost fields remain missing. This is a measured baseline for the production retrieval boundary; it is not an external provider price comparison or a real-user semantic quality claim.

# MQ-2 real-profile correction and mirror run

Date: 2026-09-07. Runtime: rebuilt packaged Electron with the supplied real
profile, CDP on port `9250`, and a named `agent-browser` session. The provider
was the profile's configured OpenAI-compatible model. Secrets are omitted.

The leader window used `?synced-leader=true`. The chat window used the normal
minimal follower route. After the session store was activated, a real chat
message sent through the visible composer reached the configured provider and
returned a response. The temporary user and assistant messages were deleted
after the check.

The leader memory store used the active profile scope (`userId: local` and the
active character-card id). The following checks used temporary records with a
unique prefix and removed every record with that prefix at the end:

- A captured event started as `short_term`, `pending`, and `active`. Approval
  changed it to `approved`; production retrieval returned its id in 494 ms.
- A superseding revision started pending. After approval, the old record was
  `superseded` and the revision was `approved` and `active`. The old query no
  longer returned the old id, and a real provider answer selected the corrected
  marker.
- An approved muscle record was returned first for its trigger. After a
  superseding correction, the old muscle id no longer returned for that
  trigger; the replacement was an approved fact without a trigger pattern.
- With the profile's long-term sync temporarily enabled, an approved temporary
  long-term row was delivered to the Docker Postgres host and its outbox then
  drained to zero. Removing the row delivered the tombstone and left the
  outbox at zero. The profile setting was restored to disabled and the host
  remained ready.

The run also found and fixed two boundary defects. The Electron host now gives
the repository an explicit empty tag list because the renderer mirror contract
does not carry tags. The renderer copies scopes, source contexts, embeddings,
and embedding metadata before Eventa transport, so Vue reactive proxies do not
fail structured cloning. The packaged rerun drained the pre-existing failed
insert and delete operations successfully.

This run covers a real profile, real provider response, local retrieval,
correction filtering, muscle-reflex invalidation, and Postgres outbox delivery.
It does not claim the 90-case MQ-0 report is a production-quality benchmark,
or cover dreaming, remote network interruption, or all social-presence paths.

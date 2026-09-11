# M01 memory extraction and new-session recall

- Status: FAIL
- Runtime: Electron build through CDP `9250`; existing user profile; character `n8cz_qXFxNLwpJmuAsfIl`; provider/model configured in the profile (credentials omitted).
- Source session: `MXMaZJpth8aD2YeqwKy9r`.
- Recall session: `7pizWp-Tro7BknZLqQFnI`.

The source turn said that the test plant in `ACC-20260907-01-M01` was named “青石”. The assistant acknowledged the fact. The Memory → Long-term page then showed an extracted short-term fragment with the same fact, current scope, and one source session. The page also showed an older superseded long-term fragment from the earlier correction chain.

The new-session probe asked for the plant name and required an answer based only on recorded information. The user message persisted, but after the diagnostic window the assistant message was empty. No valid recall answer was produced. Extraction behavior is present; cross-session answer behavior is not verified and is marked FAIL.


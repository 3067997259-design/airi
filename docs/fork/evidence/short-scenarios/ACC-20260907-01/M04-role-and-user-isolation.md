# M04 role and user isolation

- Status: FAIL (role isolation probes pass; role-scoped recall unavailable)
- Runtime: Electron build through CDP `9250`; existing user profile; credentials omitted.
- Default-role probe session: `XgXq6tWS8rXb3SRKi3CSn`.
- Custom-role probe session: `hukCjfTq0F7jDW3BjnjRB`.
- Restored custom character: `n8cz_qXFxNLwpJmuAsfIl`.

The test switched to the built-in `default` character through the AIRI card UI and asked for the custom-role identifier “松塔”. The default-role session answered that it did not know the identifier and did not return “松塔”. In that same default-role session, the test recorded “海盐” as the current-role identifier.

The test then restored the custom character through the AIRI card UI and opened a fresh session. That session was asked for the custom-role identifier while explicitly excluding the default-role value “海盐”. It answered:

> 在当前角色可见的记录与测试经历中，没有记录任何识别词。\n> \n> 我不知道。

This provides evidence that the two role contexts did not leak the other role's identifier into the answer. However, the custom-role session also failed to recall its expected existing identifier “松塔”. The role-isolation part is therefore positive, but the full acceptance case fails because role-scoped recall is unavailable.

The active character was restored to `n8cz_qXFxNLwpJmuAsfIl` after the probe. No messages or actions were sent to the restored legacy session.

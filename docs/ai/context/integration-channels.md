# Integration channel routing

This guide defines which AIRI channel an integration should use. The channel is
part of the event contract. Do not send the same fact through several channels
to make it more visible.

| Integration need | Channel | Required payload | User-visible effect |
| --- | --- | --- | --- |
| Durable world or service state | `context:update` | `contextId`, `lane`, `strategy`, bounded `text`, source metadata | Adds or replaces background context for the next prompt. |
| A small event that should wake the character | `spark:notify` | `intent`, `destinations`, short event data | Creates a character reaction without replacing context. |
| A command issued by the character | `spark:command` | `intent`, `destinations`, command data | Routes an action to the named integration. |
| A user-originated message | `input:text` | `text`, optional `contextUpdates`, source metadata | Enters the chat orchestrator and may include context updates. |
| Work with measurable progress | `task:start`, `task:progress`, `task:blocked`, `task:done` | stable `taskId`, memory snapshot, optional `logRef` | Renders a task card and feeds the task projection. |
| A completed external event | `event:reaction` | stable event id and reaction | Renders a reaction line and can be captured by memory. |

## Routing rules

- Use `context:update` for state that remains true until the integration sends a
  replacement or removal. Keep the text bounded and use a stable `contextId`.
- Use `spark:notify` for an occurrence, not a state snapshot. Include the
  integration in `destinations` when the event must reach a particular runtime.
- Use `spark:command` only when the character or a user has already chosen an
  action. The integration must validate the command at its own boundary.
- Use task events when progress, blocking, or completion must be auditable. A
  `logRef` is a pointer to evidence, not a replacement for the evidence itself.
- Attach `metadata.source.id` to every integration event. The stage can then
  filter Minecraft, Discord, Twitter, and future services without guessing from
  free-form text.

## Minecraft example

The Minecraft bot sends bounded state through `context:update` with the source
id `minecraft-bot`. It sends a noteworthy event through `spark:notify`, and it
receives character actions through `spark:command` with the destination
`minecraft-bot`. The stage settings page only configures the bot; it does not
pretend that an observed context update proves that a command succeeded.

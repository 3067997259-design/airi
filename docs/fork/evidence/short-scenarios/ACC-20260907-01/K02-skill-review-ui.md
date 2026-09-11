# K02 skill review source binding

- Status: BLOCKED
- Route: `#/settings/modules/skills`.
- Tool id: `acc-20260907-01-dedupe`.

The settings page displayed the real probation entry, risk, description, and content hash, with Approve and Reject controls. The rendered page did not expose the source module or self-test content, and the DOM contained no source/details/pre/code disclosure for the entry. The required review of the exact source and self-test before approval could therefore not be completed through the product UI. No direct store approval was used to bypass this gate; K03–K07 remain dependent on this blocker.


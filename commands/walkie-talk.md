---
description: Post a message on the walkie-talkie channel
argument-hint: "<message body, may include @mentions>"
---

Call the `walkie_talk` MCP tool with `body: "$ARGUMENTS"`. Default `type` to `broadcast`. If the operator phrased it as a question ("ask …", "find out if …"), use `type: "question"`. If the body contains `?` and a single `@<alias>`, treat it as a question.

If the tool returns `status: "permit_required"`, surface the `hint` field verbatim and stop. Do not retry.

If the tool returns `warnings` containing `unresolved-mention`, note this to the operator after the success message.

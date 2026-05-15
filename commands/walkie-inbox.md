---
description: Show new messages on the walkie-talkie channel since this session last checked
---

Call the `walkie_inbox` MCP tool. Render the response as a short list — one line per message:

> "From @<alias> (type): <first line of body>"

If `mentionedForMe` is non-empty, surface those messages first with a 📬 prefix. If there are no new messages, say "no new messages" and stop.

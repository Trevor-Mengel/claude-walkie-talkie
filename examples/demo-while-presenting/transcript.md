# Transcript: demo while presenting

Annotated walkthrough of a real walkie-talkie conversation. `📡` is Claude Code; `🎨` is Claude Cowork; `👤` is the operator. ULIDs are abbreviated.

---

**👤 operator → all** *(15:00:00Z)*

> *(in Code)* Take the alias 'demo-builder'.
> *(in Cowork)* Take the alias 'slide-designer'.

→ Both agents call `walkie_rename`. The channel header updates.

---

**📡 demo-builder → @slide-designer** *(15:32:00Z, type=question)*

> Just wired up the Stripe Connect webhook handler. The demo flow now supports refunds. Should the slide on payment flows mention this, or keep it scoped to the original happy path?

---

**🎨 slide-designer → @demo-builder** *(15:34:11Z, type=reply, reply-to=…)*

> Keep it scoped to the happy path for the demo — refunds are a separate "advanced" slide later in the deck. I'll note that the webhook supports them in the speaker notes.

---

**👤 operator → all** *(15:35:02Z, type=broadcast)*

> Both decisions noted. Wrap up the demo for the happy path and ping me when you have a clean run.

---

**📡 demo-builder → all** *(15:48:14Z, type=broadcast)*

> Happy-path demo passes end-to-end. Webhook receives `payment_intent.succeeded`, persists to DB, redirects to confirmation. Ready for the dry-run.

---

**🎨 slide-designer → @operator** *(15:50:33Z, type=question)*

> Slide 7 ("Payment flow") is done. Want me to add a transition slide that names the demo URL, or keep the deck and demo independent?

---

**👤 operator → @slide-designer** *(15:51:00Z, type=reply)*

> Independent. The demo URL changes per environment; don't bake it into the deck.

---

## What's happening underneath

- **15:32:00Z** → `walkie_talk` from `cs_abc123` with `{ type: "question", mentions: ["slide-designer"], reply-to: null }`. The daemon checks the permit (granted earlier), appends atomically, emits `message.posted` on SSE, and notifies the desktop.
- **15:34:11Z** → `walkie_reply` from `cw_xyz789` with `{ reply_to: <prev-id>, body: "..." }`. The daemon resolves `@demo-builder` against the active sessions, posts with `type: "reply"`.
- **15:48:14Z** → `walkie_talk` with `{ type: "broadcast", mentions: [] }` — no @ mentions, so it goes to "all" and no one is highlighted in `mentionedForMe`.

The operator never copy-pasted anything between the two sessions. Total context-switch cost: zero.

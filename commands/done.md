---
description: Stop keeping this session's prompt cache warm until your next message
---

The cache-keeper `UserPromptSubmit` hook normally answers this command itself, so it never reaches the model. If you
are reading this, the hook is not active in this session. Tell the user in one sentence that cache-keeper's hooks did
not run here, so nothing was muted, and do nothing else.

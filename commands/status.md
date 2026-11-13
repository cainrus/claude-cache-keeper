---
description: Show whether this session's prompt cache is warm, and which cache-keeper settings are in force
---

The cache-keeper `UserPromptSubmit` hook normally answers this command itself, so it never reaches the model. If you
are reading this, the hook is not active in this session. Tell the user in one sentence that cache-keeper's hooks did
not run here, so there is no status to show, and do nothing else.

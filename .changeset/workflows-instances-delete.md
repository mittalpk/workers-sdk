---
"wrangler": minor
"miniflare": minor
---

Add individual and batch Workflow instance deletion to the runtime and SDK.

- `env.MY_WORKFLOW.get(id).delete()` deletes one instance.
- `env.MY_WORKFLOW.deleteBatch(instanceIds)` deletes up to 100 instances and returns per-instance results.
- `wrangler workflows instances delete <name> <id..>` deletes instances remotely or in local development with `--local`.

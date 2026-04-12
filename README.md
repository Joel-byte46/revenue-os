# revenue-os
Here, a simple layer engineer an autonoumous CFO just for you


# Arbo

```text
revenue-os/
│
├── supabase/
│   │
│   ├── migrations/
│   │   ├── 001_schema.sql
│   │   ├── 002_rls.sql
│   │   ├── 003_functions.sql
│   │   └── 004_cron.sql
│   │
│   └── functions/
│       │
│       ├── orchestrator/
│       │   └── index.ts
│       │
│       ├── agent-ingestor/
│       │   └── index.ts
│       │
│       ├── agent-pipeline/
│       │   └── index.ts
│       │
│       ├── agent-leads/
│       │   └── index.ts
│       │
│       ├── agent-ads/
│       │   └── index.ts
│       │
│       ├── agent-treasury/
│       │   └── index.ts
│       │
│       ├── agent-brief/
│       │   └── index.ts
│       │
│       ├── agent-feedback/
│       │   └── index.ts
│       │
│       └── _shared/
│           ├── crypto.ts
│           ├── nango.ts
│           ├── llm.ts
│           ├── notify.ts
│           ├── python-client.ts
│           ├── rag.ts
│           ├── types.ts
│           └── prompts/
│               ├── system.rules.ts
│               ├── shared.context.ts
│               ├── pipeline.prompts.ts
│               ├── leads.prompts.ts
│               ├── ads.prompts.ts
│               ├── treasury.prompts.ts
│               ├── brief.prompts.ts
│               └── feedback.prompts.ts
│
├── python/
│   ├── main.py
│   ├── treasury.py
│   ├── anomaly.py
│   ├── requirements.txt
│   └── Dockerfile
│
└── nango/
    └── docker-compose.yml
```

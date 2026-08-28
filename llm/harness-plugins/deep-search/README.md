# Deep Search plugin

Exa-backed search tools for research-oriented web discovery.

## Environment

```env
EXA_API_KEY=...
```

## Tools

- `deep_search` — neural/auto web search with optional domains and result count
- `deep_fetch` — fetch cleaned text for one or more known URLs

This plugin returns source URLs and bounded text suitable for downstream synthesis. It is intentionally provider-specific for the MVP; a later version can expose a provider interface and add Tavily/Brave/etc.

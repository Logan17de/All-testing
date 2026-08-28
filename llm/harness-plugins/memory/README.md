# Memory plugin

Simple durable local memory for Harness.

Default store:

```text
~/.dsh/harness-memory.json
```

Override it with:

```env
DSH_MEMORY_FILE=C:\path\to\memory.json
```

## Tools

- `memory_store`
- `memory_get`
- `memory_search`
- `memory_list`
- `memory_forget`

Values are JSON, tags are optional strings, and writes use an atomic temporary-file replace.

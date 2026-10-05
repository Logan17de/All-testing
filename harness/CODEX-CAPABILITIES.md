# Standalone capability checklist

The Codex CLI/app-server runtime integration described in earlier commits has been retired.
The harness owns its model/tool loop, execution policies, conversations and UI/CLI.
Providers supply inference through model adapters. An optional official sign-in/search
integration does not own native tool execution.

See [standalone architecture and current gaps](STANDALONE-ARCHITECTURE.md) and
[provider authentication requirements](standalone-provider-auth.md). Historical test receipts
for the retired bridge remain in Git and do not establish native acceptance.

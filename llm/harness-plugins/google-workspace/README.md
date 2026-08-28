# Google Workspace plugin

Read-first Google Workspace tools using official REST APIs.

## Authentication

Either provide a current access token:

```env
GOOGLE_ACCESS_TOKEN=...
```

or OAuth refresh credentials so the plugin can refresh tokens automatically:

```env
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
```

Required OAuth scopes depend on which tools you use. Typical read scopes are Drive metadata/read, Gmail readonly, and Calendar readonly.

## Tools

- `google_drive_search`
- `google_gmail_search`
- `google_gmail_read`
- `google_calendar_events`

Write operations are intentionally not part of the first MVP.

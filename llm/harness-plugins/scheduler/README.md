# Scheduler plugin

Thin bundle over DeepSeek Harness's native `@deepseek-ai/dsh-schedule` implementation.

It provides durable Session-local model-callable scheduling tools and uses Harness's own session persistence and follow-up lifecycle instead of a separate cron loop.

Expected native tools include:

- `schedule_create`
- `schedule_list`
- `schedule_delete`

The current DSH scheduler supports future absolute times, positive delays, and fixed-rate recurrence. This wrapper intentionally follows upstream behavior so reminder state stays inside the Harness session event log.

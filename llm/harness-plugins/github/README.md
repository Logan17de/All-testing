# GitHub plugin

Native GitHub REST tools for Harness.

## Environment

```env
GITHUB_TOKEN=github_pat_...
HARNESS_GITHUB_ALLOW_WRITE=0
```

`HARNESS_GITHUB_ALLOW_WRITE=1` enables `github_create_issue` and `github_put_file`. Read tools stay available without the write flag.

## Tools

- `github_repo_info`
- `github_read_file`
- `github_search_code`
- `github_create_issue`
- `github_put_file`

The token should have only the scopes required for the repositories you want Harness to access.

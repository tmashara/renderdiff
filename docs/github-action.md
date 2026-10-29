# GitHub Action

Run renderdiff on every pull request: your preview deployment (or a build started in the job)
on the left, production on the right. The job summary shows the same compact output an agent
reads, the report and crops are uploaded as an artifact, and the step fails when renderdiff
exits non-zero.

```yaml
- uses: tmashara/renderdiff@v0
  with:
    left: ${{ github.event.deployment_status.environment_url }}
    right: https://example.com
    routes: / /about /pricing
    threshold: "0.999"
```

`v0` follows the latest 0.x release. Pin a full tag (`@v0.7.0`) to stay put.

## Inputs

| Input | |
| --- | --- |
| `left` | Your change: a preview URL or `http://localhost:3000`. Required. |
| `right` | The reference, usually production. Required. |
| `routes` | Separated by spaces or newlines; pairs (`/pricing::/plans`) work. Optional when the config lists routes. |
| `config` | Config file path. Default: `renderdiff.config.{ts,mts,js,mjs}` in the workspace. |
| `widths` | Spaces or commas. Default renderdiff's five. |
| `threshold` | Fail only below this score. Without it, any difference fails the job (exit 1); `"0"` never fails on one. |
| `concurrency` | Parallel workers, which is also the most page loads production sees at once. Default 2 on a hosted runner. |
| `storage-state` | Contents of a Playwright storage-state JSON, from a secret. Written to a 0600 file in the runner's temp dir and deleted when renderdiff exits. |
| `accept` | Record this run's differences as accepted, with this reason. See below. |
| `wait-timeout` | Whole seconds to wait for `left` to answer (any status under 500). Default 300. Past it, `exit-code` is 2. |
| `out` | Output directory, over the config's `outDir`. Default `renderdiff-out`. |
| `artifact-name` | Default `renderdiff`. |

To run the action twice in one job, give each run its own `out` and `artifact-name`; in a
matrix, put the matrix value in `artifact-name`. The action sets up Node 24, which later
steps in the job then use.

Outputs: `exit-code` (0 pass, 1 a difference or below `threshold`, 2 bad input or an origin down, 3 a route
errored) and `results` (the path to `results.json`).

A Vercel preview behind Deployment Protection answers the runner with its login page: a
401 makes every route an error, a login page served as 200 gets diffed. Turn protection off
for previews, or use a bypass, first.

## Recipes

### Preview deployment vs production

Vercel and Netlify report each preview as a GitHub deployment:

```yaml
on: deployment_status
jobs:
  renderdiff:
    if: >-
      github.event.deployment_status.state == 'success' &&
      github.event.deployment_status.environment != 'Production'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: tmashara/renderdiff@v0
        with:
          left: ${{ github.event.deployment_status.environment_url }}
          right: https://example.com
          threshold: "0.999"
```

The second condition skips production's own deployment, which would compare production to
itself. The checkout is for a committed config and `renderdiff.accepted.json`.

### A build in the job vs production

```yaml
on: pull_request
jobs:
  renderdiff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - run: npm ci && npm run build
      - run: npm start &
      - uses: tmashara/renderdiff@v0
        with:
          left: http://localhost:3000
          right: https://example.com
          threshold: "0.999"
```

The action waits for `left` to answer, so the server can still be starting.

### Dependency upgrades from Renovate or Dependabot

A dependency bump should change nothing. That's the default without `threshold`: any
difference fails.

```yaml
    if: github.actor == 'renovate[bot]' || github.actor == 'dependabot[bot]'
    # …the build-in-the-job steps above, then:
      - uses: tmashara/renderdiff@v0
        with:
          left: http://localhost:3000
          right: https://example.com
```

## Accepted differences: accept in CI

Accept where you check. Fingerprints include a hash of the pixels, and the same page renders
a few pixels differently on macOS and on the Linux runner (fonts, anti-aliasing), so entries
accepted on a Mac mostly don't match in CI. To record accepted differences for CI:

1. Run the workflow once with `accept: "<reason>"` (for example through a
   `workflow_dispatch` input).
2. Download the artifact; it holds `renderdiff.accepted.json`.
3. Commit it next to your config (or at the repo root without one).

Later runs read the committed file and stop failing on those differences; anything new
still shows. Details: [accepted.md](accepted.md).

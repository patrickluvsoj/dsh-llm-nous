# Using dsh-llm-nous

`dsh-llm-nous` adds Nous Portal models to DeepSeek Harness through the Harness plugin system.

## What you need

- DeepSeek Harness installed, or a Harness source checkout
- A Nous Portal API key from `portal.nousresearch.com → API Keys`
- A Harness profile, such as `web` or `headless`

## 1. Store the API key

Use an environment variable or the Harness credentials/settings UI. For a local shell:

```sh
export NOUS_API_KEY='your-nous-portal-key'
```

For a source checkout, put it in the checkout's gitignored `.env`:

```dotenv
NOUS_API_KEY=your-nous-portal-key
```

Never put the key in `cordis.patch.yml`, commit it, or paste it into a published package.

## 2. Install the plugin

npm is **not required**. Choose one installation method.

### Local checkout

From a Harness source checkout:

```sh
pnpm dsh plugin --profile web add --ignore-workspace-root-check /absolute/path/to/dsh-llm-nous
```

The extra `--ignore-workspace-root-check` is needed when the profile is being managed inside the Harness source workspace. With a normal installed `dsh` command, use:

```sh
dsh plugin --profile web add /absolute/path/to/dsh-llm-nous
```

### GitHub

Once the repository is published:

```sh
dsh plugin --profile web add github:patrickluvsoj/dsh-llm-nous
```

The repository includes the built `lib/index.mjs`, so GitHub installation does not need to run a build step.

Pin a commit for reproducible deployments:

```sh
dsh plugin --profile web add github:patrickluvsoj/dsh-llm-nous#COMMIT_SHA
```

### Tarball

Build or download a tarball:

```sh
pnpm pack --pack-destination /tmp
```

Install it:

```sh
dsh plugin --profile web add /tmp/dsh-llm-nous-0.1.0.tgz
```

### npm

npm is the most convenient distribution method, but it is optional:

```sh
dsh plugin --profile web add dsh-llm-nous
```

Publishing to npm mainly avoids GitHub/source-install conventions and gives users versioned package resolution.

## 3. Start Harness

```sh
dsh --profile web
```

For a source checkout:

```sh
pnpm dsh --profile web
```

The bundle registers the `nous` provider and makes its default model available to new agents.

## 4. Choose a model

### Web dashboard

Open **Settings → Models**. The Nous provider and its advertised models appear in the Harness model picker after the bundle loads. Select a model there to make it the default for new sessions. Existing sessions keep the provider/model recorded in their own log.

![Harness model settings page](assets/providers-models-page.png)

This screenshot is the upstream Harness model-settings UI; the Nous entries appear after the bundle is installed.

The plugin advertises these entries by default:

```text
deepseek/deepseek-v4-flash-0731
deepseek/deepseek-v4-pro-0813
stepfun/step-3.7-flash:free
```

### Terminal and headless runs

There is no separate plugin-specific terminal picker. Select the model through a normal Harness patch:

```yaml
- id: agent-default-model
  config:
    provider: nous
    model: stepfun/step-3.7-flash:free
```

Then run:

```sh
dsh --profile headless --patch ./nous-model.cordis.yml 'Reply with exactly: NOUS_OK'
```

Any exact Nous model ID can be used this way, even if it is not in the small advertised catalog.

## 5. Set the output budget

`maxTokens` limits how many tokens the model may generate in one response. It includes visible output, reasoning, and model-generated tool calls. It does not define conversation memory; that is the model's context window.

The plugin defaults to 8,192 because Nous models have different context limits. Raise it when the selected model supports it:

```yaml
- id: llm-nous
  config:
    apiKeyEnv: NOUS_API_KEY
    baseURL: https://inference-api.nousresearch.com/v1
    maxTokens: 32768
```

The patch replaces the entire `llm-nous` config, so include both `apiKeyEnv` and `baseURL`.

You can set a per-model cap:

```yaml
- id: llm-nous
  config:
    apiKeyEnv: NOUS_API_KEY
    baseURL: https://inference-api.nousresearch.com/v1
    maxTokens: 32768
    models:
      - id: stepfun/step-3.7-flash:free
        contextWindow: 256000
        maxTokens: 8192
      - id: deepseek/deepseek-v4-pro-0813
        contextWindow: 1048576
        maxTokens: 32768
```

The effective precedence is:

```text
explicit request maxTokens
→ model-specific maxTokens
→ plugin-wide maxTokens
→ 8,192 default
```

Keep the output cap below the selected model's total context window after accounting for conversation history, system instructions, and tool definitions.

## 6. Verify the installation

Inspect the composed profile without starting the agent:

```sh
dsh --profile web --dump-config
```

Look for:

```text
provider: nous
name: dsh-llm-nous
```

For a one-shot smoke test:

```sh
dsh --profile headless \
  --patch ./nous-model.cordis.yml \
  'Reply with exactly: NOUS_OK'
```

## Troubleshooting

### HTTP 404 mentioning credits

The request reached Nous, but the selected model is paid and the Portal account has no available credits. Choose a free model or add credits.

### HTTP 400 mentioning context length

The requested output cap plus the prompt/tool definitions exceeds the model's total context window. Lower `maxTokens` or choose a model with a larger context window.

### `MISSING_CREDENTIAL`

Harness cannot find `NOUS_API_KEY`. Export it in the launching environment or store it through the Harness credentials UI.

### `DUPLICATE_ADAPTER`

Two plugins are registering the `nous` route. Keep only one `dsh-llm-nous` bundle active in the profile.

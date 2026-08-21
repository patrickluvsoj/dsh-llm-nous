# dsh-llm-nous 🚀

Give [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) a direct line to the [Nous Portal](https://portal.nousresearch.com/) model buffet — without forking Harness or touching its core.

`dsh-llm-nous` is a standalone Harness bundle. It registers a `nous` provider route, speaks Nous's OpenAI-compatible API, and keeps the provider-specific weirdness where it belongs: inside the plugin.

## What you get

- **Provider route:** `nous`
- **Nous API:** `https://inference-api.nousresearch.com/v1`
- **Credential:** `NOUS_API_KEY`
- **Streaming:** OpenAI-compatible SSE, including Nous's clean EOF without `[DONE]`
- **Reasoning:** OpenAI-compatible `delta.reasoning`
- **Models:** picker-friendly defaults plus arbitrary Nous model IDs via configuration
- **Default output cap:** 8,192 generated tokens — raise it when your selected model has room
- **Harness core changes:** none

## Install it

npm is optional. Pick your flavor:

```sh
# GitHub — easiest for sharing
dsh plugin --profile web add github:patrickluvsoj/dsh-llm-nous

# Local checkout
dsh plugin --profile web add /absolute/path/to/dsh-llm-nous

# Tarball
dsh plugin --profile web add ./dsh-llm-nous-0.1.0.tgz

# npm, if published there later
dsh plugin --profile web add dsh-llm-nous
```

For a Harness source checkout, prefix the first two commands with `pnpm` and add `--ignore-workspace-root-check` to the install command:

```sh
pnpm dsh plugin --profile web add --ignore-workspace-root-check github:patrickluvsoj/dsh-llm-nous
```

## Add your Nous key

```sh
export NOUS_API_KEY='your-nous-portal-key'
```

For a source checkout, a gitignored `.env` works too:

```dotenv
NOUS_API_KEY=your-nous-portal-key
```

The key belongs in the environment or Harness's credential store — **not** in Cordis YAML, Git, screenshots, or package files. Tiny security basics; civilization survives another day.

## Start Harness

```sh
dsh --profile web
```

Or from the Harness source checkout:

```sh
pnpm dsh --profile web
```

The bundle defaults new sessions to:

```text
deepseek/deepseek-v4-flash-0731
```

That model is paid and requires available Nous Portal credits. The bundle also advertises this free model for testing:

```text
stepfun/step-3.7-flash:free
```

## Choose a model

### Web dashboard: point, click, model

Harness exposes configured providers in **Settings → Models**. After `dsh-llm-nous` is loaded, the Nous provider and its advertised models can appear in the model picker.

![Harness model settings page](docs/assets/providers-models-page.png)

*This is the upstream Harness model-settings UI; the Nous card/model entries appear after the Nous bundle is installed.*

Select a model in the picker and it becomes the default for **new sessions**. A session that has already sent a request keeps the provider/model recorded in its own log. Model changes apply on the next request; no server restart is needed for an ordinary selection change.

The plugin advertises these picker-friendly entries by default:

```text
deepseek/deepseek-v4-flash-0731
deepseek/deepseek-v4-pro-0813
stepfun/step-3.7-flash:free
```

The Nous catalog is much larger. A model ID that is not in this small advertised list can still be used by setting it explicitly.

### Terminal/headless: configure it directly

The plugin does not add a separate terminal picker command. For terminal or headless runs, select the model with a normal Harness patch:

```yaml
- id: agent-default-model
  config:
    provider: nous
    model: stepfun/step-3.7-flash:free
```

Run it:

```sh
dsh --profile headless --patch ./nous-model.cordis.yml \
  'Reply with exactly: NOUS_OK'
```

### Use any exact Nous model ID

Create `nous-model.cordis.yml`:

```yaml
- id: agent-default-model
  config:
    provider: nous
    model: openai/gpt-oss-120b
```

Then launch:

```sh
dsh --profile web --patch ./nous-model.cordis.yml
```

The adapter passes the model ID through to Nous unchanged. The model does not have to be in the plugin's small default catalog.

## Tune the output budget

`maxTokens` limits generated tokens for one response. That includes visible text, reasoning, and model-generated tool calls. It is not the conversation-memory limit; that is the model's context window.

Raise it for a model with enough context:

```yaml
- id: llm-nous
  config:
    apiKeyEnv: NOUS_API_KEY
    baseURL: https://inference-api.nousresearch.com/v1
    maxTokens: 32768
```

A patch replaces the entire targeted config, so keep `apiKeyEnv` and `baseURL` when overriding `llm-nous`.

Per-model caps are supported too:

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

Effective precedence:

```text
explicit request maxTokens
→ model-specific maxTokens
→ plugin-wide maxTokens
→ 8,192 default
```

## Verify the setup

Inspect the composed profile:

```sh
dsh --profile web --dump-config
```

Look for the `dsh-llm-nous` layer and `provider: nous`.

Run a tiny smoke test:

```sh
dsh --profile headless \
  --patch ./nous-model.cordis.yml \
  'Reply with exactly: NOUS_OK'
```

## Troubleshooting

### HTTP 404 mentioning credits

The request reached Nous, but the selected model is paid and the Portal account has no available credits. Choose a free model or add credits.

### HTTP 400 mentioning context length

The requested output cap plus the prompt, conversation, and tool definitions exceeds the model's total context window. Lower `maxTokens` or choose a model with more context.

### `MISSING_CREDENTIAL`

Harness cannot find `NOUS_API_KEY`. Export it in the launching environment or store it through the Harness credential UI.

### `DUPLICATE_ADAPTER`

Two plugins are registering the `nous` route. Keep only one `dsh-llm-nous` bundle active in the profile.

## Development

```sh
pnpm install
pnpm run build
pnpm test
```

The runtime artifact is `lib/index.mjs`. It bundles its runtime dependencies, so an installed bundle does not need a sibling Harness checkout.

## License

MIT

# dsh-llm-nous

A standalone [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle that adds a `nous` provider route for the [Nous Portal](https://portal.nousresearch.com/) OpenAI-compatible API.

It uses Harness's public LLM adapter seam. It does not modify Harness core or replace the shipped DeepSeek adapter.

## What it provides

- Provider route: `nous`
- API base URL: `https://inference-api.nousresearch.com/v1`
- Credential variable: `NOUS_API_KEY`
- OpenAI-compatible streaming and `delta.reasoning` handling
- Clean SSE EOF handling when Nous closes without `[DONE]`
- Pass-through model IDs for the Nous catalog
- Default output cap: 8,192 generated tokens; configure a higher cap when the selected model has enough context

## Use it

See [`docs/USAGE.md`](docs/USAGE.md) for the complete setup guide.

The short version:

```sh
# Store the key in a trusted environment layer; never put it in Cordis YAML.
export NOUS_API_KEY='your-nous-portal-key'

# Install from a local checkout, GitHub, tarball, or npm.
dsh plugin --profile web add github:patrickluvsoj/dsh-llm-nous

dsh --profile web
```

The bundle defaults new agents to `deepseek/deepseek-v4-flash-0731`. The model is paid; your Portal account needs available credits. A free test model is also advertised: `stepfun/step-3.7-flash:free`.

## Configure a model

Create a patch file such as `nous-model.cordis.yml`:

```yaml
- id: agent-default-model
  config:
    provider: nous
    model: stepfun/step-3.7-flash:free

- id: llm-nous
  config:
    apiKeyEnv: NOUS_API_KEY
    baseURL: https://inference-api.nousresearch.com/v1
    maxTokens: 32768
```

Run:

```sh
dsh --profile web --patch ./nous-model.cordis.yml
```

A patch replaces the whole targeted config, so keep `apiKeyEnv` and `baseURL` when overriding `llm-nous`.

## Development

```sh
pnpm install
pnpm run build
pnpm test
```

The published/runtime artifact is `lib/index.mjs`. The package bundles its runtime dependencies so an installed bundle does not need a sibling Harness checkout.

## License

MIT

# DeepSeek Usage Meter (plugin)

Server side of the usage meter. Serves live DeepSeek and Ollama Cloud pricing, the DeepSeek balance, and the Ollama account quota to the UI extension.

## Endpoints

- `GET /api/plugins/deepseek-usage-meter/pricing` — DeepSeek rates + peak schedule, scraped from api-docs.deepseek.com
- `GET /api/plugins/deepseek-usage-meter/balance` — DeepSeek balance, using the key already saved in SillyTavern
- `GET /api/plugins/deepseek-usage-meter/ollama/pricing` — Ollama rates + peak card, scraped from ollama.com/pricing
- `GET /api/plugins/deepseek-usage-meter/ollama/usage` — Ollama credit balance, proxied from `ollama.com/api/balance`; requires an `X-Ollama-Key` header (the UI sends the key from its settings, nothing is stored here). The path keeps its old name so existing installs do not break; Ollama's own `/api/usage` returns bucketed spend and no longer carries the session/weekly limits this used to read

## Install

From inside your SillyTavern folder:

```
git clone https://github.com/Lynixenn/deepseek-usage-meter-server plugins/deepseek-usage-meter-server && git clone https://github.com/Lynixenn/deepseek-usage-meter-ui data/default-user/extensions/deepseek-usage-meter-ui
```

Restart the server and refresh the page. It uses the DeepSeek API key already saved in SillyTavern, no extra config.

## Ollama native bridge

SillyTavern's Custom source only speaks the OpenAI format, and Ollama's OpenAI shim on `/v1` has no `num_ctx` or `keep_alive`. The plugin runs a small bridge that accepts OpenAI-style requests and sends them to Ollama's native `/api/chat`, returning thinking as `reasoning_content` and token counts as `usage`. The UI extension adds it to the source list as **Ollama (Native)**.

- It listens on its own port, `http://127.0.0.1:11435/v1`, because ST calls the Custom endpoint from the server without a session, and ST's CSRF check runs ahead of plugin routes
- It only binds to loopback and refuses requests with an `Origin` header or a non-loopback `Host`, so a web page cannot start generations on your account
- `think`, `num_ctx`, `keep_alive` and an `options` object are read from the request body. `reasoning_effort` and `reasoning.effort` also work, and `"none"` means `think: false`
- If Ollama refuses `think` because the model has no thinking support, the request is retried without it
- An API key in ST's Custom key field is forwarded to Ollama, which is needed only when the upstream is `https://ollama.com`
- `GET /api/plugins/deepseek-usage-meter/ollama/native/status` reports the bridge address and whether Ollama answers

Optional `config.yaml` settings (restart to apply):

```yaml
deepseekUsageMeterOllamaPort: 11435                 # 0 turns the bridge off
deepseekUsageMeterOllamaUrl: http://127.0.0.1:11434 # where Ollama is running
```

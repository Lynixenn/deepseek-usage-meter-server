# DeepSeek Usage Meter (plugin)

Server side of the usage meter. Serves live DeepSeek and Ollama Cloud pricing, the DeepSeek balance, and the Ollama account quota to the UI extension.

## Endpoints

- `GET /api/plugins/deepseek-usage-meter/pricing` — DeepSeek rates + peak schedule, scraped from api-docs.deepseek.com
- `GET /api/plugins/deepseek-usage-meter/balance` — DeepSeek balance, using the key already saved in SillyTavern
- `GET /api/plugins/deepseek-usage-meter/ollama/pricing` — Ollama rates + peak card, scraped from ollama.com/pricing
- `GET /api/plugins/deepseek-usage-meter/ollama/usage` — Ollama session/weekly quota; requires an `X-Ollama-Key` header (the UI sends the key from its settings, nothing is stored here)

## Install

From inside your SillyTavern folder:

```
git clone https://github.com/Lynixenn/deepseek-usage-meter-server plugins/deepseek-usage-meter-server && git clone https://github.com/Lynixenn/deepseek-usage-meter-ui data/default-user/extensions/deepseek-usage-meter-ui
```

Restart the server and refresh the page. It uses the DeepSeek API key already saved in SillyTavern, no extra config.

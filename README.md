# Kavla

Kavla is an infinite canvas for exploratory analysis. It's all about embracing the analytical mess. Paste a picture, draw some shapes, write some SQL, make a chart. Compared to a notebook, in Kavla you can easily branch your analysis and keep the dead ends around.

For a better understanding on what you can do, check out [kavla.dev](https://kavla.dev). There you can also try the web version.

It's built with tldraw and duckdb. It can connect to a few databases, see list below.

## Running

See the release page on github or go to https://kavla.dev/download

### Desktop App

Simply install the desktop app as you would normally on your system. Double click works on debian! (I dont have a Mac so I don't know if that works. Please let me know in an issue!)

### CLI

Download the CLI from the release page, then run:

```sh
kavla run
```

This will start a web server that serves the application on http://localhost:40743/.

### Docker

```sh
 docker run --rm -p 40743:40743 -v kavla-data:/data aleda145/kavla:latest
```

Or see [compose.yaml](./compose.yaml)

There is no access control for the web server. Don't put it online without adequate security!

### Agent providers

In **Agent connection**, choose **Codex login** to use your local Codex CLI login, or **API provider** to call a Chat Completions compatible provider directly. API mode does not require Codex. The model must support function tool calling. Kavla reads complete responses and runs the requested canvas tools between requests, including focused SQL and Lens generation.

For API mode, enter the provider's **base URL** (without `/chat/completions`), **model ID**, and **API key**. Extra headers are optional JSON. OpenAI defaults to `https://api.openai.com/v1` and `gpt-4.1`; use your provider's model ID for other endpoints.

For [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/usage/rest-api/):

- Base URL: `https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1`
- API key: your Cloudflare API token with Workers AI Read permission.
- Model ID: a tool-capable model from your Cloudflare model catalog, using its complete ID.
- Extra headers: `{"cf-aig-gateway-id":"<GATEWAY_ID>"}` (required for Workers AI models through AI Gateway).

Existing Cloudflare `/compat` gateway URLs also work as a base URL. They use their own model prefixes, such as `workers-ai/@cf/...`. The optional headers support gateway authentication such as `cf-aig-authorization`.

Settings entered in Agent connection are saved in `~/.kavla/agent.yaml` and restored on startup. This file includes the connection mode, base URL, model, API key, and extra headers. Credentials are stored in plain text with owner-only file permissions (`0600`), and are excluded from `.kavla` files and run journals. Blank key/header inputs preserve saved credentials for the same endpoint; `{}` clears extra headers. Changing the base URL or switching to Codex login discards entered credentials. Provider credentials are checked on the first request.

Saved settings take precedence. As an alternative, set `KAVLA_AI_BASE_URL`, `KAVLA_AI_MODEL`, and `KAVLA_AI_API_KEY` in the server environment to supply defaults for missing settings. Environment keys are not copied into the config file. Existing `OPENAI_API_KEY` and `OPENAI_BASE_URL` settings are also supported. Environment keys apply only to their configured endpoint. Providers that authenticate entirely through extra headers, or local servers without authentication, can leave the API key blank.

## Python shapes

Add **Python** from the canvas toolbar, or choose **Python →** on a SQL shape. Refer to another shape by its name; its complete result is exposed as a pandas DataFrame:

```python
result = query_1.groupby("category", as_index=False)["revenue"].sum()
result["share"] = result["revenue"] / result["revenue"].sum()
```

Assign a pandas DataFrame to `result` to publish it. Use `shapes["name"]` when a shape's name is a Python keyword or reserved name such as `result`. The pandas index is not exported; use `reset_index()` when it should become a column.

**Chart** and **Table** display the output using Kavla's existing shapes. **SQL →** creates a query referencing the Python shape, for example `SELECT * FROM python_1`. SQL and Python can be chained in either direction. This version supports backend DuckDB disk sources; browser file sources and other database adapters are outside the Python workflow.

**Run** (Ctrl/Cmd+Enter) runs required upstream steps before the selected shape. **Stop** cancels the workflow. Each Python step starts a new process, loads its inputs, runs the whole script, and exits. Variables never survive between runs. Opening a canvas or showing a chart does not execute Python.

Kavla prepares an isolated Python 3.13 environment for each document on the first run. **Packages** edits that document's requirements, one package per line, with optional version constraints. pandas, NumPy, and PyArrow are included. Initial setup downloads Python and packages; prepared environments can be reused offline. Managed setup supports Linux and macOS on x86-64 and ARM64.

Code, requirements, and the package lock are saved in `.kavla`. Result data, Python environments, and console output are excluded. After reopening, run a shape to rebuild its results. Editing code or changing packages marks dependent results stale; failed runs preserve the last successful result.

To verify the Python integration during development:

```sh
python3 cli/internal/python/worker_test.py
node app/Python/execution.test.mjs
cd cli
KAVLA_TEST_PYTHON=/path/to/venv/bin/python go test ./...
# Optional: exercise actual installer downloads in a temporary directory.
KAVLA_TEST_MANAGED_PYTHON=1 go test ./internal/python -run TestManagedEnvironment -v
```

The integration interpreter must have pandas and PyArrow installed. The coordinator tests run directly with Node's test API and do not open the app.

## Supported Sources

| Source    | Type        | Connection                                           |
| --------- | ----------- | ---------------------------------------------------- |
| DuckDB    | `duckdb`    | Path to an existing DuckDB file                      |
| Directory | `directory` | Path to a directory with CSV, Parquet, or JSON files |
| BigQuery  | `bigquery`  | Google Cloud project ID (experimental)               |
| Postgres  | `postgres`  | Postgres URI                                         |

## Collaboration

If you are interested in live multiplayer and sharing canvases with your team, check out the offering on [kavla.dev](https://kavla.dev)

After signing up you can use the same CLI to interact with kavla.dev canvases:

### Login

```sh
kavla login
```

### Connect to a canvas

```sh
kavla connect
```

Or connect directly:

```sh
kavla connect <room_id>
```

## Licensing

Kavla's original source code is licensed under the [Apache License 2.0](./LICENSE).

Third-party components remain under their own terms. See [Third-party software and licenses](./THIRD_PARTY_LICENSES.md), including the separately licensed tldraw SDK and the bundled [tldraw 3.15.4 license](./TLDRAW_LICENSE.md).

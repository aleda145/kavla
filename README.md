# Kavla

Kavla is an infinite canvas for exploratory analysis. It's all about embracing the analytical mess. Paste a picture, draw some shapes, write some SQL, make a chart. Compared to a notebook, in Kavla you can easily branch your analysis and keep the dead ends around.

For a better understanding on what you can do, check out [kavla.dev](https://kavla.dev). There you can also try the web version.

It's built with tldraw and duckdb. It can connect to a few databases, see list below.

## Running

Download here: https://github.com/aleda145/kavla/releases

### Desktop App

See release page. Simply install the desktop app as you would normally on your system. Double click works on debian! (I dont have a Mac so I don't know if that works. Please let me know in an issue!)

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

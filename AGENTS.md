# Domain

We are building Kavla.
Kavla is an infinite canvas tool for analytics. It's built for exploratory, and "messy" analysis, allowing users to:

- Upload and explore files (parquet, csv)
- Connect databases
- Write SQL queries
- Visualize results as tables, charts
- Draw, annotate, and add freeform notes/images
- Work in real time with others via multiplayer canvas (only kavla.dev, not this repo)

Kavla is about embracing the messy middle of analytics.

Standard dashboards (Metabase, Tableau etc) will force you to clean everything up for the final result. But that also hides the actual analytics work (the logic, rejected ideas, and random thoughts)

Kavla should keep this context visible!

If a stakeholder sees a number that looks wrong, they can go behind the scenes and understand how we reached the number, rather than having to set up a meeting with the creator.

## Architecture

### Frontend (app)

- Built in React using tldraw.
- When doing design work, reference the style guide: `./style_guide.md`
- Talks to the CLI via HTTP requests

#### Shapes

Shape code lives under `app/`.

- `Chart/` — standard chart shapes and the shared generated React widget runtime used by Lens.
- `SQLTextArea/` — SQL query node shape, SQL editor, query execution UI, and upstream/downstream query context.
- `SQLResultArea/` — table/result shape for query outputs.
- `DataSource/` — uploaded/attached source data shapes.
- `Summary/` — generated analysis summary shapes. (not used yet)

### Compute

All SQL compute runs in the shipped CLI backend. The browser decodes Arrow results and renders the canvas.

- The CLI DuckDB session routes configured sources and supports federated joins.
- Single-source Postgres and BigQuery queries can execute natively through the backend.
- Each document has a built-in `uploaded_files` DuckDB catalog. Uploaded originals are bundled in the `.kavla` archive and imported into native tables when its session starts.
- Upload tables belong to the document, independently of canvas source shapes.
- Version 2 archives record upload table names; version 1 archives remain readable and migrate on save.

## Commands

Never use any git features. Ask the user if you really need to, but do so rarely.
You cant view the results of the `app`. If it's really needed, ask the user
Don't run anything related to linting or formatting. The user will handle that via pre-commits.
Never remove commented out code. It's there for a reason.

## style

- Always consider backwards compatiblity. We do not want to break the .kavla files.
- Prefer failing fast vs swallowing errors
- We are using typescript. Make sure to assign correct types in React.
- We favor simplicity over complexity. Keep things grug. Repeated code is OK. We try not to abstract code unless necessary
- Large files around 1000 LOC is completely fine
- Do not write tests unless prompted to do so

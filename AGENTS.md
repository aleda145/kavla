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

There are two ways to run queries.

#### duckdb WASM

- We are using duckDB in the browser to handle data transformations for added files
- it's available in app/src/duckdb-service.ts

#### CLI

- The CLI can have many different type of sources
- See `cli/internal/sources` for available ones
- the CLI duckdb acts as a router. Any source is passed through the duckdb
- This enables different sources to be successfully joined together

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

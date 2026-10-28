# Kavla dbt example

A small, self-contained shop project for trying the canvas integration. It uses
custom model paths (`analytics/`), two seeds, two staging models, a mart, a macro,
and model descriptions. There are no database credentials.

Open **dbt** below **Agent** in Kavla and choose this directory. dbt does not need
to be installed. The models appear as normal SQL nodes and the seeds become
queryable data sources. Run `customer_orders` to preview all upstream models,
including the `cents_to_currency` macro. The result has three customers: Ada
with two completed orders totaling 67, Grace with one totaling 18, and Alan
with no completed orders. Use the SQL node's chart action or chain a query to
explore the result without adding an exploratory file to the dbt project.

Try changing `customer_orders.sql` on the canvas, then opening that file in your
editor. Change a file in your editor and watch the corresponding canvas node
update. For a conflict, pause syncing in Kavla, edit the same file in both
places, and resume. The dbt dialog offers both versions for review.

To execute the project separately, install `dbt-duckdb` in your own Python
virtual environment, then run from this directory:

```sh
mkdir -p target
dbt seed --profiles-dir .
dbt run --profiles-dir .
dbt parse --profiles-dir .
```

The local DuckDB database is created in `target/`, which Kavla excludes from
import. `profiles.yml` is also excluded from the canvas. Use a copy of this
folder if you want to keep the example unchanged.

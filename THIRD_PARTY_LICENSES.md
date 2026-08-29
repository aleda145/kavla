# Third-party software and licenses

Kavla's original source code is licensed under the Apache License 2.0. Kavla also uses third-party software that remains subject to its own copyright and license terms. The Apache License 2.0 does not replace or override those terms.

The dependency manifests and lock files are the authoritative inventory of the exact packages and versions used by a particular revision of Kavla:

- `app/package.json` and `app/yarn.lock` for the browser application
- `cli/go.mod` and `cli/go.sum` for the CLI and desktop application

## tldraw SDK

Kavla currently distributes tldraw SDK version 3.15.4 and `@tldraw/assets` version 3.15.4. These packages are provided under the separate [tldraw 3.15.4 license](https://github.com/tldraw/tldraw/blob/v3.15.4/LICENSE.md), not under Kavla's Apache-2.0 license. A verbatim copy is included in [`TLDRAW_LICENSE.md`](./TLDRAW_LICENSE.md).

The tldraw 3.15.4 license permits commercial and non-commercial use and bundling as part of another application, subject to its conditions. Among other things, distributors must not disable or alter the watermark or license-key validation and must include the license verbatim. tldraw's terms have changed in later releases, so an upgrade must be reviewed against the license shipped with that release.

## Browser application

Kavla's direct runtime dependencies include:

| Software | License |
| --- | --- |
| CodeMirror packages and `@uiw/react-codemirror` | MIT |
| DuckDB WASM and packaged DuckDB Parquet/JSON WASM extensions | MIT |
| Polyglot SQL SDK | MIT |
| TanStack Table and Virtual | MIT |
| Apache Arrow | Apache-2.0 |
| Apache ECharts | Apache-2.0 |
| ECharts for React | MIT |
| React and React DOM | MIT |
| Tailwind CSS | MIT |
| Lucide | ISC |
| Simple Icons | CC0-1.0 |
| lodash.throttle | MIT |
| sql-formatter | MIT |
| tldraw SDK and assets | tldraw license; see above |

These packages may include transitive dependencies under additional compatible licenses. Consult `app/yarn.lock` together with the license files shipped in each installed package for the complete terms of a given build.

## CLI and desktop application

Kavla's direct Go dependencies include:

| Software | License |
| --- | --- |
| Apache Arrow for Go | Apache-2.0 |
| DuckDB Go client and DuckDB | MIT |
| Google UUID | BSD-3-Clause |
| Cobra | Apache-2.0 |
| Wails | MIT |
| Go terminal packages | BSD-3-Clause |
| yaml.v3 | MIT and Apache-2.0 |
| nhooyr WebSocket | ISC |

These modules have transitive dependencies under their own licenses. Consult `cli/go.sum`, the corresponding module source distributions, and their included license files for the complete terms of a given build.

## Distribution

Source and binary redistributors must preserve the copyright notices, license texts, attribution notices, and other materials required by each third-party license. Kavla distributions include `LICENSE`, `THIRD_PARTY_LICENSES.md`, and `TLDRAW_LICENSE.md`. Links in this document are provided for convenience; the license text distributed with the corresponding dependency controls.

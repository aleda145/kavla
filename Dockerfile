# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS web-builder

WORKDIR /src/app

RUN corepack enable

COPY app/package.json app/yarn.lock ./
RUN --mount=type=cache,target=/usr/local/share/.cache/yarn \
    yarn install --frozen-lockfile

COPY app/ ./
RUN yarn build


FROM golang:1.26-bookworm AS cli-builder

WORKDIR /src/cli

COPY cli/go.mod cli/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

COPY cli/ ./
COPY --from=web-builder /src/app/dist/ ./internal/webapp/dist/

ARG KAVLA_VERSION=docker
ARG KAVLA_COMMIT=
ARG KAVLA_BUILD_DATE=

RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=1 go build -trimpath \
      -ldflags="-s -w -X github.com/aleda145/kavla/cli/cmd.Version=${KAVLA_VERSION} -X github.com/aleda145/kavla/cli/cmd.Commit=${KAVLA_COMMIT} -X github.com/aleda145/kavla/cli/cmd.BuildDate=${KAVLA_BUILD_DATE}" \
      -o /out/kavla .


FROM debian:bookworm-slim AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --home-dir /data --uid 10001 kavla

COPY --from=cli-builder /out/kavla /usr/local/bin/kavla
COPY LICENSE THIRD_PARTY_LICENSES.md TLDRAW_LICENSE.md /usr/share/doc/kavla/

USER kavla
WORKDIR /data
ENV HOME=/data

VOLUME ["/data"]
EXPOSE 40743

ENTRYPOINT ["/usr/local/bin/kavla"]
CMD ["run", "--no-browser", "--host", "0.0.0.0"]

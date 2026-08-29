.PHONY: build build-app docker-push release run

APP_SOURCES := $(shell find app -type f -not -path 'app/node_modules/*' -not -path 'app/dist/*')
CLI_SOURCES := $(shell find cli -type f \( -name '*.go' -o -name 'go.mod' -o -name 'go.sum' -o -name 'wails.json' \))
DEMO_ARCHIVE := cli/internal/demo/titanic.kavla
EMBED_STAMP := cli/internal/webapp/dist/.build-stamp
BINARY := cli/kavla
VERSION ?=
DOCKER_IMAGE ?= aleda145/kavla
DOCKER_TAG ?= latest
DOCKER_REF := $(DOCKER_IMAGE):$(DOCKER_TAG)

build: $(BINARY)

$(EMBED_STAMP): $(APP_SOURCES) Makefile
	./cli/scripts/embed-web.sh
	touch $(EMBED_STAMP)

$(BINARY): $(CLI_SOURCES) $(DEMO_ARCHIVE) $(EMBED_STAMP) Makefile
	cd cli && go build -trimpath -o .kavla.new .
	mv cli/.kavla.new $(BINARY)

build-app: $(EMBED_STAMP)
	./cli/scripts/build-linux-app.sh "$(VERSION)"

docker-push:
	docker build --build-arg KAVLA_VERSION="$(DOCKER_TAG)" --tag "$(DOCKER_REF)" .
	docker push "$(DOCKER_REF)"

release:
	$(MAKE) -C cli release VERSION="$(VERSION)"

run: $(BINARY)
	./$(BINARY) run

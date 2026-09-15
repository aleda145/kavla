.PHONY: build build-app build-appimage build-cef-appimage docker-push release run FORCE

CLI_SOURCES := $(shell find cli -type f \( -name '*.go' -o -name 'go.mod' -o -name 'go.sum' \))
DEMO_ARCHIVE := cli/internal/demo/titanic.kavla
EMBED_STAMP := cli/internal/webapp/dist/.build-stamp
BINARY := cli/kavla
VERSION ?=
DOCKER_IMAGE ?= aleda145/kavla
DOCKER_TAG ?= latest
DOCKER_REF := $(DOCKER_IMAGE):$(DOCKER_TAG)

build: $(BINARY)

# Check contents on every invocation; the script updates the stamp only after a rebuild.
$(EMBED_STAMP): FORCE
	./cli/scripts/embed-web.sh

FORCE:

$(BINARY): $(CLI_SOURCES) $(DEMO_ARCHIVE) $(EMBED_STAMP) Makefile
	cd cli && go build -trimpath -o .kavla.new .
	mv cli/.kavla.new $(BINARY)

build-app:
	@case "$$(uname -s)" in \
		Linux) bash ./cli/scripts/build-linux-cef-appimage.sh "$(VERSION)" ;; \
		Darwin) bash ./cli/scripts/build-macos-cef-app.sh "$(VERSION)" ;; \
		*) echo "CEF desktop builds support Linux and macOS" >&2; exit 1 ;; \
	esac

build-appimage: build-cef-appimage

build-cef-appimage:
	bash ./cli/scripts/build-linux-cef-appimage.sh "$(VERSION)"

docker-push:
	docker build --build-arg KAVLA_VERSION="$(DOCKER_TAG)" --tag "$(DOCKER_REF)" .
	docker push "$(DOCKER_REF)"

release:
	$(MAKE) -C cli release VERSION="$(VERSION)"

run: $(BINARY)
	./$(BINARY) run

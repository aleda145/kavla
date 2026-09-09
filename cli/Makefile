VERSION ?=
GITHUB_REPOSITORY ?= aleda145/kavla

.PHONY: test build embed release

test:
	go test ./...

embed:
	./scripts/embed-web.sh

build: embed
	go build -o kavla .

release:
	@if [ -z "$(VERSION)" ]; then \
		echo "VERSION is required. Example: make release VERSION=v0.1.0"; \
		exit 1; \
	fi
	@if ! printf '%s' "$(VERSION)" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$$'; then \
		echo "VERSION must match stable semver format like v0.1.0"; \
		exit 1; \
	fi
	@if [ -n "$$(git status --porcelain)" ]; then \
		echo "The working tree has uncommitted changes. Commit them before releasing."; \
		exit 1; \
	fi
	@if git rev-parse -q --verify "refs/tags/$(VERSION)" >/dev/null; then \
		echo "Tag $(VERSION) already exists locally"; \
		exit 1; \
	fi
	@if git ls-remote --exit-code --tags origin "refs/tags/$(VERSION)" >/dev/null 2>&1; then \
		echo "Tag $(VERSION) already exists on origin"; \
		exit 1; \
	fi
	@git tag "$(VERSION)"
	@git push origin "$(VERSION)"
	@echo "Created and pushed $(VERSION)"
	@echo "GitHub Actions will publish CLI and CEF desktop artifacts."
	@echo "Release page: https://github.com/$(GITHUB_REPOSITORY)/releases/tag/$(VERSION)"

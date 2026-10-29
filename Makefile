PORT ?= 4173
HOST ?= 0.0.0.0

.PHONY: all install validate build serve clean

all: serve

node_modules: package.json package-lock.json
	npm ci
	@touch node_modules

install: node_modules

# Check iwsdk.config.json against the IWSDK project schema.
validate: node_modules
	npx --yes ajv-cli@5.0.0 validate --spec=draft2020 \
		-s node_modules/@iwsdk/core/dist/schemas/iwsdk-project.v1.schema.json \
		-d iwsdk.config.json

# Type-check and bundle into dist/
build: node_modules
	npm run build

# Serve the built dist/ statically. vite preview honors the
# '/vwm-portal-lab/' base path, matching GitHub Pages.
serve: build
	@echo "Serving at https://localhost:$(PORT)/vwm-portal-lab/"
	npx vite preview --host $(HOST) --port $(PORT) --strictPort

clean:
	rm -rf dist

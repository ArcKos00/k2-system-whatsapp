# WhatsApp API Gateway 2.x — Go (whatsmeow), no browser.
# Image rules: ~/warspace/docs/docker.md (BuildKit, every FROM through Nexus, dependency layer before code,
# cache mounts, smallest runtime, K2 roots in the trust store, files root-owned, process uid 1001).
ARG REGISTRY=10.20.50.25:8081
ARG GO_VERSION=1.27.4

# K2 roots ship in the full Nexus node image (/usr/local/share/ca-certificates/*.crt).
FROM ${REGISTRY}/node:26 AS k2ca

FROM ${REGISTRY}/golang:${GO_VERSION}-alpine AS build
WORKDIR /src
ENV CGO_ENABLED=0 GOFLAGS=-mod=readonly
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod,sharing=locked go mod download
COPY VERSION ./
COPY cmd ./cmd
COPY internal ./internal
# Unit tests gate the image (integration tests need Postgres/RabbitMQ and run with -tags integration).
RUN --mount=type=cache,target=/go/pkg/mod,sharing=locked --mount=type=cache,target=/root/.cache/go-build \
    go vet ./... && go test ./... \
    && go build -trimpath -ldflags "-s -w -X main.Version=$(cat VERSION)" -o /out/wa-reader ./cmd/wa-reader
# Public roots of the build image + K2 roots, one bundle (Go reads /etc/ssl/certs/ca-certificates.crt).
COPY --from=k2ca /usr/local/share/ca-certificates/ /k2-ca/
RUN { cat /etc/ssl/certs/ca-certificates.crt; for f in /k2-ca/*.crt; do echo; cat "$f"; done; } > /out/ca-certificates.crt

FROM ${REGISTRY}/alpine:3.23 AS runtime
# Jenkins passes the ISO week (--build-arg BASE_REFRESH="$(date +%G-W%V)") so security updates of the
# base land once a week while the layer is cached in between; the Trivy gate blocks fixable CRITICALs.
ARG BASE_REFRESH=none
RUN echo "base refresh: ${BASE_REFRESH}" && apk upgrade --no-cache
COPY --from=build /out/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/wa-reader /usr/local/bin/wa-reader
USER 1001:1001
EXPOSE 3000
ENV PORT=3000
# Go handles SIGTERM itself (graceful shutdown, session closed, owner lock released): no init needed.
ENTRYPOINT ["/usr/local/bin/wa-reader"]

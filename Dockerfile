# Multi-stage build for the pager relay. The build host and the DO cluster are
# both linux/amd64, so a native `docker build` produces the right image — no
# buildx cross-compile needed. The PWA's WASM is built here too, so the image is
# self-contained and reproducible (no committed build artifacts).

FROM rust:1.96-slim-bookworm AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
        pkg-config libssl-dev libcurl4-openssl-dev git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN rustup target add wasm32-unknown-unknown \
    && curl -sSf https://rustwasm.github.io/wasm-pack/installer/init.sh | sh

WORKDIR /build
COPY . .
# Build the device WASM into pwa/wasm, then the relay binary.
RUN wasm-pack build wasm --release --target no-modules --out-dir pwa/wasm --out-name pager_wasm
RUN cargo build -p pager-relay --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates libssl3 libcurl4 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=builder /build/target/release/pager-relay /usr/local/bin/pager-relay
COPY --from=builder /build/pwa /app/pwa
ENV PAGER_PWA_DIR=/app/pwa \
    PAGER_RELAY_ADDR=0.0.0.0:4500 \
    PAGER_VAPID_FILE=/secrets/vapid.json
EXPOSE 4500
USER nobody
CMD ["pager-relay"]

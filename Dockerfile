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
# Build the device WASM into /build/pwa/wasm (absolute: wasm-pack resolves
# --out-dir relative to the crate dir otherwise), then the relay binary.
RUN wasm-pack build wasm --release --target no-modules --out-dir /build/pwa/wasm --out-name pager_wasm
RUN cargo build -p pager-relay -p pager-bridge --release

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

# The bridge, for running one beside the always-on services rather than only on
# a laptop: it holds its own device keys and seals its own notifications, so
# what a service raises reaches the phone while every laptop is asleep. Its
# capture endpoint is unauthenticated and must never be routable beyond the
# senders that are meant to reach it.
FROM debian:bookworm-slim AS bridge
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates libssl3 libcurl4 \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /build/target/release/pager-bridge /usr/local/bin/pager-bridge
# Keys and paired devices live here (bridge.json); mount it, or the identity
# and every pairing are lost on restart. No USER is set: the deployment picks
# one that can write the mounted volume.
ENV PAGER_CONFIG_DIR=/state \
    PAGER_CAPTURE_ADDR=0.0.0.0:4500 \
    PAGER_RELAY_URL=https://pager.0x69.xyz
EXPOSE 4500
# Split, not one CMD: Kubernetes `args` replaces CMD wholesale and leaves
# ENTRYPOINT alone. With the binary in CMD, a deployment that says
# `args: ["run"]` — the obvious thing to write — execs "run" and crash-loops.
ENTRYPOINT ["pager-bridge"]
CMD ["run"]

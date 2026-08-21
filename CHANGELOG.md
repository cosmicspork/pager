# Changelog

## [0.5.0](https://github.com/cosmicspork/pager/compare/v0.4.0...v0.5.0) (2026-08-21)


### Features

* **bridge:** add a doctor command that walks the whole chain ([f4a7eb7](https://github.com/cosmicspork/pager/commit/f4a7eb71ef902f5b53029fdf8336e9a05f2b44c8))
* make delivery observable end to end ([eda55d6](https://github.com/cosmicspork/pager/commit/eda55d6ecafebad681c833a005f54894ec594451))
* **pwa:** surface alert permission and push subscription state ([09afcec](https://github.com/cosmicspork/pager/commit/09afcec87faf4fca66227cad48ada23f469a8497))


### Bug Fixes

* **pwa:** keep recording pushes when the alert can't be shown ([ab4b92f](https://github.com/cosmicspork/pager/commit/ab4b92f88c3f4f63efc997f2bd5700974a2cfc69))

## [0.4.0](https://github.com/cosmicspork/pager/compare/v0.3.0...v0.4.0) (2026-08-20)


### Features

* **extension:** capture Teams from IndexedDB with per-kind filtering ([17fb8bc](https://github.com/cosmicspork/pager/commit/17fb8bc06788d8a448b93fb1f5facd9002ca868d))
* **extension:** keep-active for Teams, plus settings and injection toggles ([7ef9bc3](https://github.com/cosmicspork/pager/commit/7ef9bc3278809053eb67371c5699c91dbdc9d199))


### Bug Fixes

* **extension:** harden Teams IndexedDB capture from code review ([c498769](https://github.com/cosmicspork/pager/commit/c49876906f5dad779f56a38f0b8cebb7df02816d))
* **extension:** make activity simulation transparent ([60c4ea6](https://github.com/cosmicspork/pager/commit/60c4ea614bd81abde7fbefb0a0027ed27803c9e4))
* **extension:** patch fetch only on Outlook hosts ([977327a](https://github.com/cosmicspork/pager/commit/977327afebf04f1b96aa2f8d574f73c400c0bdff))
* **extension:** patch fetch only on Outlook hosts ([3917d6c](https://github.com/cosmicspork/pager/commit/3917d6cd3c9d4b115e29e933b5d89599b14a8bf1))
* **extension:** stop the mask swallowing every focus and blur ([694a1a1](https://github.com/cosmicspork/pager/commit/694a1a1ebadd3b1e4c453ad11fa82e4d26911635))

## [0.3.0](https://github.com/cosmicspork/pager/compare/v0.2.0...v0.3.0) (2026-06-29)


### Features

* **pwa:** green-phosphor pager redesign ([4460edd](https://github.com/cosmicspork/pager/commit/4460edd823d1e06b0c29e7eaaed91d2a8c0347e2))
* **pwa:** redesign as a green-phosphor pager ([4e2385c](https://github.com/cosmicspork/pager/commit/4e2385c601000c009f7a131e44c341cfe6ab98ea))

## [0.2.0](https://github.com/cosmicspork/pager/compare/v0.1.0...v0.2.0) (2026-06-29)


### Features

* finish bridge, deploy tooling, and device pairing ([775bcf8](https://github.com/cosmicspork/pager/commit/775bcf8afea26bc0c0134c6bc8f1335b036c29b7))
* **pwa:** device-local notification log ([89d2d98](https://github.com/cosmicspork/pager/commit/89d2d98feb8ad086a34be39d1d4d08199654de1d))
* **pwa:** device-local notification log ([6d882d0](https://github.com/cosmicspork/pager/commit/6d882d05d40a1519192d1ce04a817575b6d35901))
* zero-knowledge pager — relay, bridge, device WASM, PWA pairing ([3d94c73](https://github.com/cosmicspork/pager/commit/3d94c73d717440d92bf28dc0ab1e92934dcc1158))


### Bug Fixes

* **bridge:** only notify on newly delivered mail, not conversation syncs ([3833507](https://github.com/cosmicspork/pager/commit/3833507b4a5c58d62a4b933a97414dfcad10bbe9))
* **bridge:** only notify on newly delivered mail, not conversation syncs ([b91e9ab](https://github.com/cosmicspork/pager/commit/b91e9abf948ddabe351349e17da7206a3476dd4e))
* **test:** make the relay integration test hermetic ([fb26f67](https://github.com/cosmicspork/pager/commit/fb26f6782d1bc374321900cc77c450965d1ff07f))
* **test:** make the relay integration test hermetic ([96004aa](https://github.com/cosmicspork/pager/commit/96004aac42b3add82b40eb77f77b1058fb7931c2))

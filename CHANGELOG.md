# Changelog

## [1.0.0](https://github.com/runnane/elegoo-web/compare/v0.2.1...v1.0.0) (2026-09-16)

### ⚠ BREAKING CHANGES

* **config:** the service now refuses to start without PRINTER_IP. Checked
  before making it: production sets it in .env (which the installer excludes from
  its rsync --delete, so it survives), and the README, docker-compose example and
  .env.example all set it explicitly. Nothing was relying on the default.

  Restoring the old default turns three of the new tests red.

* **agents:** adopt the userspace instruction bundle (ELEG-81) ([#75](https://github.com/runnane/elegoo-web/issues/75)) ([06f6e30](https://github.com/runnane/elegoo-web/commit/06f6e3020aea979479c1ce3c246d6163fc29db14))
* **build:** use import.meta.dirname in vite.config.ts (ELEG-87) ([#87](https://github.com/runnane/elegoo-web/issues/87)) ([0ee0dcf](https://github.com/runnane/elegoo-web/commit/0ee0dcf56ea0a944a51d98468f14dffe8699123b))
* **ci:** move the three actions off the deprecated Node 20 runtime (ELEG-62) ([#49](https://github.com/runnane/elegoo-web/issues/49)) ([ec0778d](https://github.com/runnane/elegoo-web/commit/ec0778dc21ed288b62fed86a4d1c449a2133ad9a))
* **deploy:** stop the installer printing warnings on a healthy deploy (ELEG-19) ([#21](https://github.com/runnane/elegoo-web/issues/21)) ([3c787c8](https://github.com/runnane/elegoo-web/commit/3c787c8d2b70252d14a8aff342594328cfaa0957))
* **deps-dev:** bump @biomejs/biome from 2.5.7 to 2.5.9 ([#77](https://github.com/runnane/elegoo-web/issues/77)) ([14bb7b4](https://github.com/runnane/elegoo-web/commit/14bb7b4fe2b5499fd492ae5ebd3eb9776055a1f4))
* **deps-dev:** bump @biomejs/biome from 2.5.9 to 2.5.12 ([#96](https://github.com/runnane/elegoo-web/issues/96)) ([6f46a76](https://github.com/runnane/elegoo-web/commit/6f46a769aef7b14619f068f0afa5414bdadf35c1))
* **deps-dev:** bump concurrently from 10.0.4 to 10.0.5 ([#76](https://github.com/runnane/elegoo-web/issues/76)) ([c0ac198](https://github.com/runnane/elegoo-web/commit/c0ac198660bffd755a5affa5fc9102341a5b7baf))
* **deps-dev:** bump knip from 6.33.0 to 6.34.0 ([#93](https://github.com/runnane/elegoo-web/issues/93)) ([4972a12](https://github.com/runnane/elegoo-web/commit/4972a12c66cefd932db4d453be43854dfc49b0a2))
* **deps-dev:** bump release-it from 21.0.1 to 21.0.2 ([#71](https://github.com/runnane/elegoo-web/issues/71)) ([1bd63cd](https://github.com/runnane/elegoo-web/commit/1bd63cd5128f38e9a98fc38f86c44d9cb4eb7bb7))
* **deps-dev:** bump vite from 8.2.1 to 8.2.2 ([#92](https://github.com/runnane/elegoo-web/issues/92)) ([6205ce6](https://github.com/runnane/elegoo-web/commit/6205ce65fd15d9c948db4c3591a1dd19aed85431))
* **deps:** bump @vitest/mocker ([#95](https://github.com/runnane/elegoo-web/issues/95)) ([da68a0f](https://github.com/runnane/elegoo-web/commit/da68a0f2685ec79443d18e2bc91f0b8b2572b366))
* **deps:** bump docker/build-push-action from 6 to 7 ([#61](https://github.com/runnane/elegoo-web/issues/61)) ([1911e50](https://github.com/runnane/elegoo-web/commit/1911e502db528b11a0d5345de6fecc78263d3406))
* **deps:** bump docker/login-action from 3 to 4 ([#57](https://github.com/runnane/elegoo-web/issues/57)) ([70ad291](https://github.com/runnane/elegoo-web/commit/70ad2918d34e3670b84085b35d5594f6e7719354))
* **deps:** bump docker/metadata-action from 5 to 6 ([#60](https://github.com/runnane/elegoo-web/issues/60)) ([60404f2](https://github.com/runnane/elegoo-web/commit/60404f273400826bbe690691d78a7b88b3b25762))
* **deps:** bump docker/setup-buildx-action from 3 to 4 ([#58](https://github.com/runnane/elegoo-web/issues/58)) ([31d0470](https://github.com/runnane/elegoo-web/commit/31d0470425c3fe6476c048dda024923a6d9e0b8b))
* **deps:** bump docker/setup-qemu-action from 3 to 4 ([#59](https://github.com/runnane/elegoo-web/issues/59)) ([428c8bd](https://github.com/runnane/elegoo-web/commit/428c8bdab059c96d68f5cb46405104cbd3f1d40e))
* **deps:** bump grammy from 1.45.1 to 1.46.0 ([#97](https://github.com/runnane/elegoo-web/issues/97)) ([b71b9cb](https://github.com/runnane/elegoo-web/commit/b71b9cbc880cb2ff14ea19836d3f97993fad6221))
* **deps:** bump node from 22-slim to 25-slim ([#10](https://github.com/runnane/elegoo-web/issues/10)) ([5c3e01a](https://github.com/runnane/elegoo-web/commit/5c3e01a900725892df3c5fe7414df0fcdc563fc2))
* **deps:** bump pdfkit from 0.19.1 to 0.20.2 ([#98](https://github.com/runnane/elegoo-web/issues/98)) ([9dba9cc](https://github.com/runnane/elegoo-web/commit/9dba9cc7c9f7aec53ee969799d8a24386e4fdbe6))
* **deps:** bump sharp in the npm_and_yarn group across 1 directory ([#101](https://github.com/runnane/elegoo-web/issues/101)) ([de3cb63](https://github.com/runnane/elegoo-web/commit/de3cb637b790fcbd6137ff46907bca596c65f5e9))
* **deps:** bump tsx from 4.23.11 to 4.23.12 ([#74](https://github.com/runnane/elegoo-web/issues/74)) ([fa0fcf1](https://github.com/runnane/elegoo-web/commit/fa0fcf153dd1a0bfa092ccd07b487a47a7c874f5))
* **deps:** bump tsx from 4.23.12 to 4.23.13 ([#91](https://github.com/runnane/elegoo-web/issues/91)) ([39832f7](https://github.com/runnane/elegoo-web/commit/39832f7f8f4a2c58fd2a0a2e81c25b8b9261a8d0))
* **deps:** bump ws from 8.21.2 to 8.21.3 ([#73](https://github.com/runnane/elegoo-web/issues/73)) ([523d70b](https://github.com/runnane/elegoo-web/commit/523d70b78271542d7572cbf7109bca090e4a0e17))
* **docs:** retire TODO.md — the open items are now ELEG issues ([#27](https://github.com/runnane/elegoo-web/issues/27)) ([37992aa](https://github.com/runnane/elegoo-web/commit/37992aa70627b76923cf512911fcff8843bb860f))
* **gates:** add knip as a dead-code gate, and delete the two files it found (ELEG-65) ([#82](https://github.com/runnane/elegoo-web/issues/82)) ([7b3bc8a](https://github.com/runnane/elegoo-web/commit/7b3bc8ac4e8c332096808ca670f05678c9d77b8f))
* **gates:** typecheck and lint the two root config files (ELEG-79) ([#78](https://github.com/runnane/elegoo-web/issues/78)) ([1a59cf8](https://github.com/runnane/elegoo-web/commit/1a59cf8c7fbf08295ddb0b7f5ddfb787673e3dac))
* **mcp:** assert MCP.md matches the registered tools and resources (ELEG-7) ([bba79d6](https://github.com/runnane/elegoo-web/commit/bba79d6279410e1f0f1753bffe9f5abaf91ebe4a))
* **telegram:** delete the unreachable standalone bot and its second MQTT client (ELEG-23) ([#44](https://github.com/runnane/elegoo-web/issues/44)) ([1fbb3d0](https://github.com/runnane/elegoo-web/commit/1fbb3d04e898e1929b71a7a581d7bc7e06547b7d))
* **ui:** add a jsdom environment and assert the list bar's focus invariant (ELEG-61) ([#50](https://github.com/runnane/elegoo-web/issues/50)) ([206a325](https://github.com/runnane/elegoo-web/commit/206a325e186887e19989402ab68af095583a11c0))
* **ui:** give jsdom a working localStorage and assert real persistence (ELEG-64) ([#83](https://github.com/runnane/elegoo-web/issues/83)) ([780b8d9](https://github.com/runnane/elegoo-web/commit/780b8d9db5a7a6e84dc3c2f80c716887e3351239))

### Features

* add CI workflow for automated testing and linting ([80d1c8d](https://github.com/runnane/elegoo-web/commit/80d1c8d535c04f04cabc78cc875201aba22e8ca8))
* add dependabot configuration for npm and docker updates ([4d6bea3](https://github.com/runnane/elegoo-web/commit/4d6bea33d2464301593379c26893580d87a16b72))
* add lint-staged configuration for improved code quality checks ([a8371e7](https://github.com/runnane/elegoo-web/commit/a8371e74556e98507a7f8f366a30fefbeb245678))
* **ci:** run pnpm gates as CI's single step (ELEG-5) ([56c3098](https://github.com/runnane/elegoo-web/commit/56c3098e5a383e0c9f5041f069d78f2ab4a65da2))
* **deploy:** stamp the deployed commit and report it from /api/health ([#16](https://github.com/runnane/elegoo-web/issues/16)) ([e6bb182](https://github.com/runnane/elegoo-web/commit/e6bb1827003392c34dac59784f095d8f27fab065))
* enhance Dockerfile with source label and improve release hook for Docker login ([2be1d69](https://github.com/runnane/elegoo-web/commit/2be1d690d8ce135c4a6f797e1483baceb8ed0e12))
* **monitoring:** tell the two broker_only states apart (ELEG-59) ([#51](https://github.com/runnane/elegoo-web/issues/51)) ([d6baac1](https://github.com/runnane/elegoo-web/commit/d6baac1f43dd59ba50429f72a3a8ed4a8fc0b0c9))
* **ui:** audible alert on print completion and critical errors (ELEG-46) ([#84](https://github.com/runnane/elegoo-web/issues/84)) ([25745fd](https://github.com/runnane/elegoo-web/commit/25745fd004b0ffe776cfe5f83c4b66c43aad382a))
* **ui:** delete print history entries, using method 1038 (ELEG-38) ([#36](https://github.com/runnane/elegoo-web/issues/36)) ([4097497](https://github.com/runnane/elegoo-web/commit/4097497562955388821123c537b815bf641ac743))
* **ui:** export the MQTT log as JSON (ELEG-31) ([#34](https://github.com/runnane/elegoo-web/issues/34)) ([79e5a04](https://github.com/runnane/elegoo-web/commit/79e5a04535c1481265c460ef85cc3df5a8055c1b))
* **ui:** light theme, including the canvas charts (ELEG-34) ([#35](https://github.com/runnane/elegoo-web/issues/35)) ([15f46c3](https://github.com/runnane/elegoo-web/commit/15f46c3df2d75f97a5f3478b056348b78764401d))
* **ui:** prompt to resume or cancel after a power loss (ELEG-29) ([#33](https://github.com/runnane/elegoo-web/issues/33)) ([982208c](https://github.com/runnane/elegoo-web/commit/982208c56866206826180cfce5a0f1d0552986c3))
* **ui:** relative log timestamps as a toggle, not a replacement (ELEG-45) ([#85](https://github.com/runnane/elegoo-web/issues/85)) ([3169904](https://github.com/runnane/elegoo-web/commit/316990409372767f8a3ee09ac71f2a0d3e045f6a))
* **ui:** show the running version as x.y.z+aa, the way RCP does (ELEG-48) ([#54](https://github.com/runnane/elegoo-web/issues/54)) ([6a65572](https://github.com/runnane/elegoo-web/commit/6a65572a19f1cd28da0323e7af89da282fa2c9d4))
* **ui:** sort, text filter and outcome filter for Print Reports (ELEG-51) ([#41](https://github.com/runnane/elegoo-web/issues/41)) ([2495dc0](https://github.com/runnane/elegoo-web/commit/2495dc0a70385d39470dbd2ec77bd1a4480a68a4))
* **ui:** sort, text filter and state filter for Timelapse (ELEG-52) ([#42](https://github.com/runnane/elegoo-web/issues/42)) ([2098413](https://github.com/runnane/elegoo-web/commit/20984136e8fab616db6bd2755dc5590a84671ae2))
* **ui:** sort, text filter and status filter for Print History (ELEG-50) ([#40](https://github.com/runnane/elegoo-web/issues/40)) ([85be1ca](https://github.com/runnane/elegoo-web/commit/85be1cac822541b6bd070b9965c9107887ff84b7))
* **ui:** sortable, filterable Files list and a shared helper for the other three (ELEG-49) ([#39](https://github.com/runnane/elegoo-web/issues/39)) ([cea09e3](https://github.com/runnane/elegoo-web/commit/cea09e32b2f1253ec276401cea834403daad16d4))
* update ESLint configuration and TypeScript include paths for improved linting and type checking ([7f30480](https://github.com/runnane/elegoo-web/commit/7f304800218f0427b2175f8666b0bf0fc5556f2a))

### Bug Fixes

* **ai:** stop VLM defaulting on, aimed at a hardcoded private address (ELEG-72) ([#63](https://github.com/runnane/elegoo-web/issues/63)) ([225bd79](https://github.com/runnane/elegoo-web/commit/225bd79049c14bbc899f2dcc94535771863d873d))
* **chart:** keep the layer-time chart inside its plot area (ELEG-16) ([#20](https://github.com/runnane/elegoo-web/issues/20)) ([e5e02d2](https://github.com/runnane/elegoo-web/commit/e5e02d2d86afecefe46c04fbd72a90da989db723))
* **ci:** pin pnpm and move settings to pnpm-workspace.yaml (ELEG-4) ([4c25ea1](https://github.com/runnane/elegoo-web/commit/4c25ea1eedc5cb98c302e88e49cc7b89aca4c360))
* **ci:** point :latest at main, because nothing cuts releases (ELEG-75) ([#68](https://github.com/runnane/elegoo-web/issues/68)) ([c6cd5ad](https://github.com/runnane/elegoo-web/commit/c6cd5adf0a44aa694514f5602f5d852e7328cf6e)), references [#9](https://github.com/runnane/elegoo-web/issues/9)
* **config:** read dev-server allowedHosts from the environment (ELEG-82) ([#79](https://github.com/runnane/elegoo-web/issues/79)) ([64668d0](https://github.com/runnane/elegoo-web/commit/64668d099b600b03e42aec06ec77289c0bd26ccf))
* **config:** require PRINTER_IP instead of defaulting to a real LAN address (ELEG-73) ([#65](https://github.com/runnane/elegoo-web/issues/65))
* **deploy:** make the installer copy delete-consistent with rsync --delete ([#17](https://github.com/runnane/elegoo-web/issues/17)) ([01e782c](https://github.com/runnane/elegoo-web/commit/01e782c749f42764d5be200757299abd8dcea576))
* **deploy:** set the modes on /opt/elegooweb instead of inheriting them (ELEG-20) ([#22](https://github.com/runnane/elegoo-web/issues/22)) ([628d7e4](https://github.com/runnane/elegoo-web/commit/628d7e4128934db30ff4c4b87d1898f0da05c07a))
* **deps:** clear all 38 dependency advisories with security floors (ELEG-63) ([#45](https://github.com/runnane/elegoo-web/issues/45)) ([30dca36](https://github.com/runnane/elegoo-web/commit/30dca363fb982065b9804b15fc8b73ab4d3af3c8))
* **docker:** install fonts so the camera overlay is readable (ELEG-71) ([#62](https://github.com/runnane/elegoo-web/issues/62)) ([9420a20](https://github.com/runnane/elegoo-web/commit/9420a20bf78b754dca6d1b429f4291cf9b96f057))
* **docker:** make the image buildable, publishable and current (ELEG-69) ([#56](https://github.com/runnane/elegoo-web/issues/56)) ([1b744ba](https://github.com/runnane/elegoo-web/commit/1b744ba5b8c5515b250883b95c47eef7aa82b3ca)), references [#9](https://github.com/runnane/elegoo-web/issues/9) [#10](https://github.com/runnane/elegoo-web/issues/10)
* **docs:** correct three commented options in the compose example (ELEG-77) ([#70](https://github.com/runnane/elegoo-web/issues/70)) ([87a751c](https://github.com/runnane/elegoo-web/commit/87a751cca894081eda098c5d5fbdfc25b8c1a165))
* **docs:** stop the README bind-mount example destroying persistence (ELEG-76) ([#69](https://github.com/runnane/elegoo-web/issues/69)) ([90e66de](https://github.com/runnane/elegoo-web/commit/90e66de20d213d49f535504942b9a3bc2d6955a9))
* **mcp:** update respawn-control URL to a fixed endpoint ([c834c18](https://github.com/runnane/elegoo-web/commit/c834c1896810a97c5b455e6eeaafe20aa12fc44e))
* **moonraker:** use 'local' storage_media for print start ([#94](https://github.com/runnane/elegoo-web/issues/94)) ([6f2e261](https://github.com/runnane/elegoo-web/commit/6f2e26154a57e7c72054d24598ed62743746a9f4))
* **mqtt:** announce a disconnect once, not once per reconnect attempt (ELEG-74) ([#64](https://github.com/runnane/elegoo-web/issues/64)) ([b808323](https://github.com/runnane/elegoo-web/commit/b808323883cd48e5b22463569389c34fbeadfc12))
* **protocol:** stop sending method 1062, which this firmware always refuses (ELEG-55) ([#52](https://github.com/runnane/elegoo-web/issues/52)) ([dd31334](https://github.com/runnane/elegoo-web/commit/dd3133484cf6e84ee4f1fc1d7859bfe5241cae5c))
* **server:** default to same-origin instead of Access-Control-Allow-Origin: * (ELEG-24) ([#26](https://github.com/runnane/elegoo-web/issues/26)) ([4665e43](https://github.com/runnane/elegoo-web/commit/4665e433077966598389341be6426f71a6cd677d))
* **server:** honour DATA_DIR for the gcode cache and debug captures (ELEG-70) ([#66](https://github.com/runnane/elegoo-web/issues/66)) ([4ab3295](https://github.com/runnane/elegoo-web/commit/4ab3295c197fed7e667687005a476b945ba6beca))
* **server:** remember the printer SN so a restart cannot hang forever (ELEG-60) ([#38](https://github.com/runnane/elegoo-web/issues/38)) ([4b500ae](https://github.com/runnane/elegoo-web/commit/4b500aefb0952e252b0c2d8ce358d80f0573b326))
* **server:** stop Moonraker compat fabricating JWTs and user accounts (ELEG-53) ([#53](https://github.com/runnane/elegoo-web/issues/53)) ([5b00442](https://github.com/runnane/elegoo-web/commit/5b00442269843a1fefb1bfc81f5d865dddeb32b4))
* **server:** stop the compat layers advertising authentication they never check (ELEG-26) ([#32](https://github.com/runnane/elegoo-web/issues/32)) ([0510341](https://github.com/runnane/elegoo-web/commit/05103411bf6de64574473fd81bb6b9699c4b0e16))
* **state:** sanitise a restored layer series at the boundary (ELEG-18) ([#24](https://github.com/runnane/elegoo-web/issues/24)) ([95b6431](https://github.com/runnane/elegoo-web/commit/95b6431dbfa900e05eac2794d0d15ac9c6f729a0))
* **telegram:** gate inbound bot commands on the sender id (ELEG-3) ([#23](https://github.com/runnane/elegoo-web/issues/23)) ([6fa1b65](https://github.com/runnane/elegoo-web/commit/6fa1b65cbfbb3f270e10d66d750c0bd1b2c1a3f4))
* **ui:** make a new dashboard card reach the settings list, and confirm layout reset (ELEG-44) ([#31](https://github.com/runnane/elegoo-web/issues/31)) ([58e0ba1](https://github.com/runnane/elegoo-web/commit/58e0ba187b1db74d28220b43ffcbcfdcd6087ddb))
* **ui:** show a placeholder for a thumbnail that will not decode (ELEG-42) ([#29](https://github.com/runnane/elegoo-web/issues/29)) ([ba1bb37](https://github.com/runnane/elegoo-web/commit/ba1bb372862de0fbb21d1ad6a59e13d30421914c))
* **ui:** surface printer-busy rejections instead of failing silently (ELEG-40) ([#28](https://github.com/runnane/elegoo-web/issues/28)) ([b555c6f](https://github.com/runnane/elegoo-web/commit/b555c6fd02e31ab672c8406e7752c80bfbf1113b))
* **ui:** trap keyboard focus in the camera overlay (ELEG-41) ([#86](https://github.com/runnane/elegoo-web/issues/86)) ([126cf7b](https://github.com/runnane/elegoo-web/commit/126cf7b846803a597bd9f9d216a97e19dabc252c))
* update AI monitoring references and improve error handling in WebSocket connections ([073ed37](https://github.com/runnane/elegoo-web/commit/073ed37a43231dc2daa038d92c4cd9042d5db1c3))
* update MCP server documentation to reflect the addition of a new tool and resource ([968b0e0](https://github.com/runnane/elegoo-web/commit/968b0e0edb019c1c96f55cd59f04541b9e59bbc0))

### Refactors

* simplify import statements for better readability ([90cbb80](https://github.com/runnane/elegoo-web/commit/90cbb8067b26ac394b9c68ef3f84bf0e87d74ded))
* **ui:** truncate text in CSS, not in TypeScript (ELEG-43) ([#30](https://github.com/runnane/elegoo-web/issues/30)) ([c0f5027](https://github.com/runnane/elegoo-web/commit/c0f5027c1e8b183964ae9938f216f0550cae0ff6))

### Documentation

* **agents:** adopt the RCP agent workflow, drop swamp (ELEG-1) ([3f670cb](https://github.com/runnane/elegoo-web/commit/3f670cb2e8e929391eb34f88d28cd1162e13cf8d))
* **agents:** correct the exposure claim — a curl from the host proves nothing (ELEG-8) ([0246c42](https://github.com/runnane/elegoo-web/commit/0246c424ceb27e9e7b03864284d422b49db1307d)), references [#11](https://github.com/runnane/elegoo-web/issues/11) [#11](https://github.com/runnane/elegoo-web/issues/11)
* **agents:** do the reads yourself before filing an OPERATOR issue ([#55](https://github.com/runnane/elegoo-web/issues/55)) ([a6a060a](https://github.com/runnane/elegoo-web/commit/a6a060a37529b6dced769abadd4d3d3d76e37658))
* **agents:** record the list-view control pattern and the missing DOM environment ([#43](https://github.com/runnane/elegoo-web/issues/43)) ([04ff397](https://github.com/runnane/elegoo-web/commit/04ff397c9b1e4b999e7683230e6966113ab713cd))
* **agents:** record why the parallel gate split does not apply here (ELEG-78) ([#80](https://github.com/runnane/elegoo-web/issues/80)) ([5cab261](https://github.com/runnane/elegoo-web/commit/5cab2610f497e4ace1d6b7659181d9afc8d256a4))
* **agents:** stop citing protocol references that are not in a clone (ELEG-66) ([#81](https://github.com/runnane/elegoo-web/issues/81)) ([8afe5ce](https://github.com/runnane/elegoo-web/commit/8afe5ce674ed9f2b05f719175dfff3cd0c136ba1))
* **agents:** treat a method number in an issue as an unchecked claim (ELEG-57) ([#37](https://github.com/runnane/elegoo-web/issues/37)) ([f8a6831](https://github.com/runnane/elegoo-web/commit/f8a6831304158da248be320dbbe0364018d6975b))
* **agents:** write service paths from config.dataDir, never cwd (ELEG-70) ([#67](https://github.com/runnane/elegoo-web/issues/67)) ([2cef4c7](https://github.com/runnane/elegoo-web/commit/2cef4c71932eb9e4b4bb19633a24381e09794964))
* **commands:** stop telling agents CI is red before it runs a gate ([#18](https://github.com/runnane/elegoo-web/issues/18)) ([028c006](https://github.com/runnane/elegoo-web/commit/028c0069b96f188c19f365be42bd9a72a9959c45))
* **gates:** stop asserting a test count that nothing updates (ELEG-15) ([#25](https://github.com/runnane/elegoo-web/issues/25)) ([257db84](https://github.com/runnane/elegoo-web/commit/257db84722e12af8e21a2d6135f175d0c6fae0be))

## [0.2.1](https://github.com/runnane/elegoo-web/compare/v0.3.0...v0.2.1) (2026-04-14)

### Refactors

* improve code formatting and consistency across multiple files ([da6ca24](https://github.com/runnane/elegoo-web/commit/da6ca24302ebdd80109d11e5dbfc0855d6d5bc5c))

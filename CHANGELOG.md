# Changelog

## [1.2.0](https://github.com/runnane/elegoo-web/compare/v1.1.2...v1.2.0) (2026-11-25)

* **deps-dev:** bump jsdom from 30.1.2 to 30.1.3 ([#169](https://github.com/runnane/elegoo-web/issues/169)) ([65c366f](https://github.com/runnane/elegoo-web/commit/65c366fdeccd638c63f3e0261fd6a91a06a93d3a))
* **deps-dev:** bump jsdom to 31.0.1 and raise the Node floor to 22.22.2 (ELEG-156) ([#205](https://github.com/runnane/elegoo-web/issues/205)) ([ac9104a](https://github.com/runnane/elegoo-web/commit/ac9104a77aaa7c77ede2950aafe398d231afb08c)), references [#190](https://github.com/runnane/elegoo-web/issues/190)
* **deps-dev:** bump vite from 8.3.4 to 8.3.8 ([#192](https://github.com/runnane/elegoo-web/issues/192)) ([7b455dc](https://github.com/runnane/elegoo-web/commit/7b455dc48f06bad4f9609fbaf8d210fb681c7be2))
* **deps:** bump @modelcontextprotocol/sdk from 1.32.1 to 1.32.2 ([#193](https://github.com/runnane/elegoo-web/issues/193)) ([b610f4d](https://github.com/runnane/elegoo-web/commit/b610f4d9388aed0a9a34b7db195058a3ecc16273))
* **deps:** bump dotenv from 18.0.7 to 18.0.8 ([#168](https://github.com/runnane/elegoo-web/issues/168)) ([93dee17](https://github.com/runnane/elegoo-web/commit/93dee1796d581bf4a06e63cce679553039637553))
* **deps:** bump fast-uri ([#172](https://github.com/runnane/elegoo-web/issues/172)) ([07f8534](https://github.com/runnane/elegoo-web/commit/07f85345bdd95630ad4502cdab108cca397e99df))
* **deps:** bump ws from 8.22.0 to 8.23.0 ([#191](https://github.com/runnane/elegoo-web/issues/191)) ([f46a1c3](https://github.com/runnane/elegoo-web/commit/f46a1c3178ef6746288d57186222339fd407c5bd))
* **deps:** hold @types/node majors to the engines floor in Dependabot (ELEG-146) ([#189](https://github.com/runnane/elegoo-web/issues/189)) ([763bc98](https://github.com/runnane/elegoo-web/commit/763bc985545a2ff698f4db8cf69821b46b1535e0)), references [#176](https://github.com/runnane/elegoo-web/issues/176)
* **deps:** move the pnpm pin 11.26.0 to 11.28.5 (ELEG-125) ([#165](https://github.com/runnane/elegoo-web/issues/165)) ([5785a43](https://github.com/runnane/elegoo-web/commit/5785a43eecbd25cad1f5e4aef7948ea913c1dfce))
* **deps:** move the pnpm pin to 12.22.0 with pmOnFail: ignore and a single-document lockfile gate (ELEG-138) ([#204](https://github.com/runnane/elegoo-web/issues/204)) ([4924b1a](https://github.com/runnane/elegoo-web/commit/4924b1aa8ba69898f13ebb445f71b4c37664bcd5))
* **deps:** pin @types/node to the Node 22 floor and state it in engines (ELEG-124) ([#164](https://github.com/runnane/elegoo-web/issues/164)) ([5e7f9f1](https://github.com/runnane/elegoo-web/commit/5e7f9f174b39e4d4ba85f2493d31db598fe5e4fa))
* **deps:** refresh transitive dependencies in range (ELEG-122) ([#157](https://github.com/runnane/elegoo-web/issues/157)) ([085669b](https://github.com/runnane/elegoo-web/commit/085669bf44648e7121d26650e38f9259f3aff1ec))
* **deps:** take the dependency releases ELEG-117 held back (ELEG-119) ([#154](https://github.com/runnane/elegoo-web/issues/154)) ([1431ee6](https://github.com/runnane/elegoo-web/commit/1431ee66ee39fd9f2c97ebfdee4ea681312435f9))
* **deps:** take the in-range releases ELEG-122 held for age (ELEG-123) ([#166](https://github.com/runnane/elegoo-web/issues/166)) ([9970212](https://github.com/runnane/elegoo-web/commit/99702127924451c152d0c465520e1a15ac01112e))
* **mcp:** expand the respawn-control url from ${RESPAWN_MCP_URL} (ELEG-133) ([#183](https://github.com/runnane/elegoo-web/issues/183)) ([ef4c6b8](https://github.com/runnane/elegoo-web/commit/ef4c6b867a9b0b3aaa80b102188e9480b3f8ba7c))
* **server:** wait for the renamed cache file, not the .part, in download-stall (ELEG-147) ([#196](https://github.com/runnane/elegoo-web/issues/196)) ([b544a41](https://github.com/runnane/elegoo-web/commit/b544a412a1c1f268053a62914cf3bee289e5dc37))

### Features

* **mcp:** gate the /mcp control tools behind SERVICE_API_KEY (ELEG-141) ([#199](https://github.com/runnane/elegoo-web/issues/199)) ([2fc1767](https://github.com/runnane/elegoo-web/commit/2fc17678e764f36829caf7a853c36eac85259971))
* **server:** gate /ws command frames per method behind SERVICE_API_KEY, with a default-deny read allowlist (ELEG-140) ([#200](https://github.com/runnane/elegoo-web/issues/200)) ([5914f8a](https://github.com/runnane/elegoo-web/commit/5914f8ac04d379801db3411023d32b13b51606e3))
* **server:** gate every /api/* write behind SERVICE_API_KEY, and make the SPA send it (ELEG-139) ([#194](https://github.com/runnane/elegoo-web/issues/194)) ([4d5f455](https://github.com/runnane/elegoo-web/commit/4d5f455f8ec6ca24692b5fb3be92f4598b1cb8e4))
* **server:** gate Moonraker writes behind SERVICE_API_KEY on /moonraker/*, :7125 HTTP and both :7125 WebSockets (ELEG-142) ([#203](https://github.com/runnane/elegoo-web/issues/203)) ([e100e0e](https://github.com/runnane/elegoo-web/commit/e100e0e1d09eb2b8c36664cd9a72d9c3d9fa5b28))
* **server:** gate OctoPrint-compat writes behind SERVICE_API_KEY on /octoprint/* and :7125/api/* (ELEG-143) ([#202](https://github.com/runnane/elegoo-web/issues/202)) ([192c635](https://github.com/runnane/elegoo-web/commit/192c6350c559db5aa204e54fe9916bd41b050e0a))

### Bug Fixes

* **contrib:** stop install.sh writing a private LAN address into the generated .env (ELEG-148) ([#197](https://github.com/runnane/elegoo-web/issues/197)) ([659b81e](https://github.com/runnane/elegoo-web/commit/659b81e97d0046852e4f474a15bcfd0d41e491a5))
* **deps:** bump concurrently to 10.0.6, closing shell-quote GHSA-pqg4-j6r4-53mv (ELEG-121) ([#156](https://github.com/runnane/elegoo-web/issues/156)) ([805676a](https://github.com/runnane/elegoo-web/commit/805676ab3c6391feb6559a70f99e795dd50330b9))
* **deps:** floor basic-ftp at 6.2.1, closing GHSA-c475-qrg2-pj4r (ELEG-118) ([#155](https://github.com/runnane/elegoo-web/issues/155)) ([f9f9616](https://github.com/runnane/elegoo-web/commit/f9f96164d5ea1b02f4e954041ca550258e4e2750))
* **deps:** gcode-preview 3.0.0-alpha.7 with three 0.185.1, follow mode kept on the printed layer (ELEG-120) ([#195](https://github.com/runnane/elegoo-web/issues/195)) ([7cfcfc1](https://github.com/runnane/elegoo-web/commit/7cfcfc14a811432c2409ddcd5537bf6150147ecd)), references [#177](https://github.com/runnane/elegoo-web/issues/177)
* **deps:** raise the transitive security floors past the 15 open Dependabot alerts (ELEG-137) ([#188](https://github.com/runnane/elegoo-web/issues/188)) ([eb4a799](https://github.com/runnane/elegoo-web/commit/eb4a799db2c71164f03d8e4935225043d25ff0fa))
* **server:** admit DELETE in the /api/* CORS preflight (ELEG-149) ([#198](https://github.com/runnane/elegoo-web/issues/198)) ([cfb7a32](https://github.com/runnane/elegoo-web/commit/cfb7a3264f54c6a8e4fe9ef3d5dfa351732499ed))
* **server:** end the download response and drop the partial cache when the printer stalls (ELEG-131) ([#185](https://github.com/runnane/elegoo-web/issues/185)) ([a0e2bf5](https://github.com/runnane/elegoo-web/commit/a0e2bf5a3d234a7d28da837b1dcc34d47b06614d))
* **server:** play timelapses through the printer's authenticated /download endpoint (ELEG-160) ([#211](https://github.com/runnane/elegoo-web/issues/211)) ([0b395b9](https://github.com/runnane/elegoo-web/commit/0b395b952ee24ffdc9664d839a54b4774d0b7a0a)), closes [#209](https://github.com/runnane/elegoo-web/issues/209), references [runnane/elegoo-web#209](https://github.com/runnane/elegoo-web/issues/209)
* **ui:** drop the dead connect-dialog inputs that carried a hard-coded printer address (ELEG-132) ([#186](https://github.com/runnane/elegoo-web/issues/186)) ([7362a1f](https://github.com/runnane/elegoo-web/commit/7362a1f9f96879e81b6e2f104f01d549c14e9104))
* **ui:** give each service status indicator a glyph and accessible name, not colour alone (ELEG-130) ([#187](https://github.com/runnane/elegoo-web/issues/187)) ([5da3186](https://github.com/runnane/elegoo-web/commit/5da31863f8b6055a0ebdac17ce34ecb5f0b50d3e))
* **ui:** say the presets API takes SERVICE_API_KEY, not that it has no authentication (ELEG-157) ([#206](https://github.com/runnane/elegoo-web/issues/206)) ([ed8b966](https://github.com/runnane/elegoo-web/commit/ed8b9664d30680eda7a76c35724d170421be1551))
* **ui:** stop the gcode animate loop for a file loaded through the local file input (ELEG-151) ([#201](https://github.com/runnane/elegoo-web/issues/201)) ([dae264a](https://github.com/runnane/elegoo-web/commit/dae264a896eb843df70a8c60564e29aec9028634))

### Documentation

* **agents:** say production runs on one host, not necessarily yours (ELEG-155) ([#207](https://github.com/runnane/elegoo-web/issues/207)) ([bcd7a11](https://github.com/runnane/elegoo-web/commit/bcd7a1114694920c68940f701bd0d401dad1231f))
* **gates:** record the decision to stay on pnpm 11, with the pnpm 12 measurements (ELEG-128) ([#184](https://github.com/runnane/elegoo-web/issues/184)) ([39325a3](https://github.com/runnane/elegoo-web/commit/39325a3470a0acd4fd75640255503f1ee71b3d7f))
* name the userspace bundle's r-prefixed commands (ELEG-89) ([#163](https://github.com/runnane/elegoo-web/issues/163)) ([6f81a4a](https://github.com/runnane/elegoo-web/commit/6f81a4aff3a2679b3f738952b9e4b8559fb6f4b3))
* say .mcp.json fixes the portal URL and only the token comes from the env (ELEG-129) ([#167](https://github.com/runnane/elegoo-web/issues/167)) ([2676e61](https://github.com/runnane/elegoo-web/commit/2676e6193e4ea3025050f93e83018ad95c2988e5))

## [1.1.2](https://github.com/runnane/elegoo-web/compare/v1.1.1...v1.1.2) (2026-10-02)

* **deps-dev:** bump @vitest/coverage-v8 from 4.1.10 to 5.0.1 ([#137](https://github.com/runnane/elegoo-web/issues/137)) ([f395904](https://github.com/runnane/elegoo-web/commit/f395904de1e691298f900a0093c635ebc8f4f45d))
* **deps:** bump dotenv from 17.4.2 to 18.0.2 ([#138](https://github.com/runnane/elegoo-web/issues/138)) ([746a7a9](https://github.com/runnane/elegoo-web/commit/746a7a989f9347c3e5cf8bdb28fc96dbe5253cb4))
* **deps:** bump fast-uri in the npm_and_yarn group across 1 directory ([#141](https://github.com/runnane/elegoo-web/issues/141)) ([fb0f097](https://github.com/runnane/elegoo-web/commit/fb0f0970547f470b8ef44187021bbb0714f38129))
* **deps:** bump tsx from 4.23.13 to 4.23.15 ([#139](https://github.com/runnane/elegoo-web/issues/139)) ([00dda5e](https://github.com/runnane/elegoo-web/commit/00dda5ebbc6cfa2593b68b10ee3dd89c8691563f))
* **deps:** bump ws and @types/ws ([#147](https://github.com/runnane/elegoo-web/issues/147)) ([9a5dc4f](https://github.com/runnane/elegoo-web/commit/9a5dc4fc70fe7aea266bc8f4b65dea97a3bdbf0f))

### Bug Fixes

* **deps:** dependency update, closing the undici, ip-address and fflate advisories (ELEG-117) ([#149](https://github.com/runnane/elegoo-web/issues/149)) ([eb35532](https://github.com/runnane/elegoo-web/commit/eb35532c063c52f782d5e0ac91ecc44b3772bd1d))
* play timelapses through the service so they work behind a reverse proxy (ELEG-114) ([#148](https://github.com/runnane/elegoo-web/issues/148)) ([2e8d523](https://github.com/runnane/elegoo-web/commit/2e8d52304733328c6810e5eca108d3200b3d9d8a))
* **server:** only reset the heartbeat on our own api_response ([#143](https://github.com/runnane/elegoo-web/issues/143)) ([ec1f490](https://github.com/runnane/elegoo-web/commit/ec1f4907c3591b5c65cfde99db0cf9b22e7c430c))
* **server:** only skip superseded frames for slow clients ([#144](https://github.com/runnane/elegoo-web/issues/144)) ([f35911a](https://github.com/runnane/elegoo-web/commit/f35911a3bb0e8b58b8b8c3ba71b0b0949a5c3d80))

## [1.1.1](https://github.com/runnane/elegoo-web/compare/v1.1.0...v1.1.1) (2026-09-24)

* **deps-dev:** bump @biomejs/biome from 2.5.12 to 2.5.14 ([#133](https://github.com/runnane/elegoo-web/issues/133)) ([15d9d45](https://github.com/runnane/elegoo-web/commit/15d9d459c8a6a548bb5732c3d3f50a0806186eaa))
* **deps-dev:** bump vitest from 5.0.0 to 5.0.1 ([#130](https://github.com/runnane/elegoo-web/issues/130)) ([2fce0b7](https://github.com/runnane/elegoo-web/commit/2fce0b74425ef00353fa751dee63b4970d544e02))
* **deps:** bump @huggingface/transformers from 4.2.0 to 4.3.0 ([#131](https://github.com/runnane/elegoo-web/issues/131)) ([7f5f93d](https://github.com/runnane/elegoo-web/commit/7f5f93dfb8ef58022b571c9c81c21c6cbec5feb0))
* **deps:** bump mqtt from 5.15.2 to 5.16.0 ([#132](https://github.com/runnane/elegoo-web/issues/132)) ([5f52eb7](https://github.com/runnane/elegoo-web/commit/5f52eb7f168fb0169a886cc9bc4191d158a30638))
* **deps:** bump the npm_and_yarn group across 1 directory with 3 updates ([#134](https://github.com/runnane/elegoo-web/issues/134)) ([048362a](https://github.com/runnane/elegoo-web/commit/048362ae9cc5095799f0509abe55feb7afad3c8b))

### Bug Fixes

* **ui:** let a printer without a usable Canvas tray start a print (ELEG-113) ([#136](https://github.com/runnane/elegoo-web/issues/136)) ([bd6e7c8](https://github.com/runnane/elegoo-web/commit/bd6e7c8ed8ae94539daa560539ba6d4f751a1d6f)), references [#135](https://github.com/runnane/elegoo-web/issues/135)

## [1.1.0](https://github.com/runnane/elegoo-web/compare/v1.0.0...v1.1.0) (2026-09-16)

* **compat:** pin the Moonraker and OctoPrint state translations (ELEG-97) ([#109](https://github.com/runnane/elegoo-web/issues/109)) ([da709f2](https://github.com/runnane/elegoo-web/commit/da709f2bc29e9a93de196a259046dfafbc4f526a)), references [#107](https://github.com/runnane/elegoo-web/issues/107)
* **config:** pin loadConfig's port and Telegram refusals (ELEG-92) ([#108](https://github.com/runnane/elegoo-web/issues/108)) ([b425ed8](https://github.com/runnane/elegoo-web/commit/b425ed8efc54ccccd47dce97b6f93f12df0418d0)), references [#107](https://github.com/runnane/elegoo-web/issues/107)
* **config:** pin PRINTER_IP's octet-out-of-range refusal (ELEG-103) ([#123](https://github.com/runnane/elegoo-web/issues/123)) ([2a6115b](https://github.com/runnane/elegoo-web/commit/2a6115b70d40ffbcf20aa501737ea78892e87d8c))
* **deps-dev:** bump @release-it/conventional-changelog ([#118](https://github.com/runnane/elegoo-web/issues/118)) ([9ecede7](https://github.com/runnane/elegoo-web/commit/9ecede7e7c8bb60741b755256d3f30ddda092d9e))
* **deps-dev:** bump release-it from 21.0.2 to 21.0.3 ([#119](https://github.com/runnane/elegoo-web/issues/119)) ([348347b](https://github.com/runnane/elegoo-web/commit/348347b4c874229af8cbf04f196469abf323fe4d))
* **deps-dev:** bump simple-git-hooks from 2.13.1 to 2.14.0 ([#120](https://github.com/runnane/elegoo-web/issues/120)) ([6135f6d](https://github.com/runnane/elegoo-web/commit/6135f6d7dc3349acd00c4deb000a24263e608aeb))
* **deps-dev:** bump vite from 8.2.2 to 8.3.0 ([#117](https://github.com/runnane/elegoo-web/issues/117)) ([2d2db9a](https://github.com/runnane/elegoo-web/commit/2d2db9ad3d51596a484422bd78ee860b22991b5c))
* **deps:** move to pnpm 11 with allowBuilds and a dependabot cooldown (ELEG-9) ([#104](https://github.com/runnane/elegoo-web/issues/104)) ([4915377](https://github.com/runnane/elegoo-web/commit/4915377aad95252bb33afbac95a7b09bb8906e89))
* **docker:** keep .claude/ agent worktrees out of the build context (ELEG-88) ([#103](https://github.com/runnane/elegoo-web/issues/103)) ([dca882b](https://github.com/runnane/elegoo-web/commit/dca882bce51c5d0b9ecdace27c1ed1317b63791c))
* **lint:** migrate biome.json to the 2.5.12 schema (ELEG-111) ([#128](https://github.com/runnane/elegoo-web/issues/128)) ([14053b2](https://github.com/runnane/elegoo-web/commit/14053b26f66825b3a8c74881ef3d1be49ef2bb22))
* **state:** pin that an absent delta field leaves state unchanged, in both deepMerge copies (ELEG-91) ([#106](https://github.com/runnane/elegoo-web/issues/106)) ([0632aef](https://github.com/runnane/elegoo-web/commit/0632aef8fec4304e15e733c105c43de0a55e71a9))

### Features

* **ci:** cut releases from a workflow and gate every PR on a conventional landing subject (ELEG-112) ([#129](https://github.com/runnane/elegoo-web/issues/129)) ([be1b8bd](https://github.com/runnane/elegoo-web/commit/be1b8bdd5f7646d0ed94f5a13c6d0225f5bbd1cd))
* print queue with a confirmation before every job (ELEG-35) ([#114](https://github.com/runnane/elegoo-web/issues/114)) ([6928f3e](https://github.com/runnane/elegoo-web/commit/6928f3e67877d62edcd3f91d63e4ea0620e7bc3e))
* **server:** connection presets — switch the active printer without a restart (ELEG-95) ([#113](https://github.com/runnane/elegoo-web/issues/113)) ([bfd688c](https://github.com/runnane/elegoo-web/commit/bfd688cb6b27880a91c6bd1668e11b71958d11c3))
* **server:** make the bind address configurable with BIND_ADDRESS (ELEG-93) ([#107](https://github.com/runnane/elegoo-web/issues/107)) ([8abdff7](https://github.com/runnane/elegoo-web/commit/8abdff7ea6ac313944ee2808c86e81647a82f966))
* **server:** tell Telegram and Moonraker clients about a firmware update in progress (ELEG-104) ([#126](https://github.com/runnane/elegoo-web/issues/126)) ([03717ce](https://github.com/runnane/elegoo-web/commit/03717cea5e0e06f9c88f786d26019642393a3d8d))
* **ui:** keyboard shortcuts, with a modifier and confirmation on destructive actions (ELEG-33) ([#111](https://github.com/runnane/elegoo-web/issues/111)) ([d50dbc7](https://github.com/runnane/elegoo-web/commit/d50dbc74dedaf0868a6413f79e485ab029f6fd66))
* **ui:** optional desktop notification alongside the audible alert (ELEG-84) ([#112](https://github.com/runnane/elegoo-web/issues/112)) ([4b3aea3](https://github.com/runnane/elegoo-web/commit/4b3aea374d2421306abe82cfb3e9a95caf65ddf8))
* **ui:** show firmware-update progress read-only, with a do-not-power-off banner (ELEG-98) ([#110](https://github.com/runnane/elegoo-web/issues/110)) ([a9c77fe](https://github.com/runnane/elegoo-web/commit/a9c77fec34fb01422d41716707cc80c5c1dc535b)), references [#ota-banner](https://github.com/runnane/elegoo-web/issues/ota-banner) [#exception-banner](https://github.com/runnane/elegoo-web/issues/exception-banner)

### Bug Fixes

* **release:** stop release-it building and pushing an unstamped image over CI's tags (ELEG-110) ([#121](https://github.com/runnane/elegoo-web/issues/121)) ([01dcc72](https://github.com/runnane/elegoo-web/commit/01dcc724293b3d88cd4f0a7fa31979d3b3bc140d))
* **server:** clear the print queue when the active printer changes (ELEG-107) ([#125](https://github.com/runnane/elegoo-web/issues/125)) ([4c60b86](https://github.com/runnane/elegoo-web/commit/4c60b86a03ba381b59c95208f38c723539e8bc43))
* **server:** key the gcode cache by printer as well as file name (ELEG-105) ([#116](https://github.com/runnane/elegoo-web/issues/116)) ([405d3f7](https://github.com/runnane/elegoo-web/commit/405d3f7a32f5cb930ca788ea69a748b268b28731))
* **ui:** fit the header and views at phone widths (ELEG-90) ([#105](https://github.com/runnane/elegoo-web/issues/105)) ([36324ca](https://github.com/runnane/elegoo-web/commit/36324cabc206fa92408e936fc62e81c87f2836a3)), references [#88](https://github.com/runnane/elegoo-web/issues/88) [#88](https://github.com/runnane/elegoo-web/issues/88)
* **ui:** label SetDeviceName at 1043 and capacity once, at 1048 (ELEG-85) ([#102](https://github.com/runnane/elegoo-web/issues/102)) ([d42d3eb](https://github.com/runnane/elegoo-web/commit/d42d3eb7bd8b5288a8e0cc76c420007fdfb38fa6))
* **ui:** move OTA, home-status and fan labels to 1039/1006/1004 and drop the sub-status rows from METHOD_NAMES (ELEG-100) ([#127](https://github.com/runnane/elegoo-web/issues/127)) ([7013914](https://github.com/runnane/elegoo-web/commit/701391481632aa1be265f13a8018977e934a3e14))

### Refactors

* **server:** one IPv4 validator for PRINTER_IP, BIND_ADDRESS and presets (ELEG-106) ([#124](https://github.com/runnane/elegoo-web/issues/124)) ([6fcf185](https://github.com/runnane/elegoo-web/commit/6fcf185d1d8de2d6067a5e7429b66e8130da6135))

### Documentation

* **agents:** fix the dead relative links left behind by the ELEG-81 move (ELEG-102) ([#115](https://github.com/runnane/elegoo-web/issues/115)) ([5a001a1](https://github.com/runnane/elegoo-web/commit/5a001a13aadd19a3e8510dcef2478a5f6ae7c9c2))
* **agents:** production is the compose stack in /opt/elegooweb, not the systemd unit (ELEG-109) ([#122](https://github.com/runnane/elegoo-web/issues/122)) ([6f48d98](https://github.com/runnane/elegoo-web/commit/6f48d98f574713956204233700b5d3d87eec7ac6))

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

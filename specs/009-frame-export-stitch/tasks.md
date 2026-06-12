# Tasks: Frame Export & Stitch

**Input**: Design documents from `specs/009-frame-forge-stitch/`
**Prerequisites**: plan.md ?, spec.md ?, research.md ?, data-model.md ?, contracts/api.md ?, quickstart.md ?

**Organization**: Tasks grouped by user story for independent implementation and testing.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup ¡ª crate ¹Ç¼Ü + ¹¹½¨ + @alivecss/aliveui ÒıÈë

**Purpose**: ½¨Á¢ frame-forge Rust crate¡¢C# ·şÎñ¹Ç¼Ü¡¢@alivecss/aliveui npm ÒÀÀµ¡¢Makefile/CI ¸üĞÂ¡£

- [x] T001 ´´½¨ `src/frame-forge/Cargo.toml`£ºpackage `frame-forge` edition 2021£»ÒÀÀµ tokio(full)¡¢ffmpeg-next(codec+format+software-scaling)¡¢image¡¢imageproc¡¢lru¡¢anyhow¡¢gif¡¢webp¡¢serde¡¢serde_json¡¢opencv¡¢rustfft
- [x] T002 ´´½¨ `src/frame-forge/src/main.rs` Õ¼Î»¹Ç¼Ü£¨¿Õ `tokio::main`£¬`cargo check` Í¨¹ı£©
- [x] T003 [P] ´´½¨ `src/JellyfinSuite.Plugin/Services/FrameExportService.cs` Õ¼Î»¹Ç¼Ü£ºÀàÉùÃ÷ + IDisposable + Unix socket Â·¾¶³£Á¿ + StartAsync/StopAsync stub
- [x] T004 [P] ´´½¨ `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` Õ¼Î»¹Ç¼Ü£ºApiController + Route("JellyfinSuite/FrameExport") + AllowAnonymous + ¹¹Ôìº¯Êı DI
- [x] T005 [P] ´´½¨ `src/JellyfinSuite.Plugin/Models/FrameExportDto.cs`£º¶¨Òå GenerateRequest¡¢GenerateResponse¡¢TaskProgress¡¢FrameQualityMeta µÈ DTO Àà
- [x] T006 [P] °²×° @alivecss/aliveui£º`cd src/player-enhancer && npm install @alivecss/aliveui`£¬È·ÈÏ `package.json` ÓĞÒÀÀµ¼ÇÂ¼
- [x] T007 ¸üĞÂ `Makefile`£ºĞÂÔö build-frame-forge target£¨Docker ubuntu:24.04 + libopencv-dev + ffmpeg dev libs + cargo build --release ¡ú cp µ½ Plugin Ä¿Â¼£©¡¢build ÒÀÀµ¼Ó build-frame-forge¡¢update ×·¼Ó docker cp¡¢test-rust ×·¼Ó cd src/frame-forge && cargo test
- [x] T008 [P] ¸üĞÂ `.github/workflows/build.yml`£ºCache Rust build workspaces ¼Ó src/frame-forge¡¢ĞÂÔö apt install libopencv-dev libavcodec-dev... ²½Öè¡¢test-rust ÓÉ Makefile ×Ô¶¯¸²¸Ç
- [x] T009 [P] ¸üĞÂ `.github/workflows/release.yml`£ºCache Rust build workspaces ¼Ó src/frame-forge¡¢ĞÂÔö apt install libopencv-dev¡¢ĞÂÔö Build frame-forge (Linux x64) ²½Öè£¨cargo build --release£©¡¢Copy binaries ²½Öè¼Ó frame-forge-linux-x64¡¢zip ´ò°ü¼Ó frame-forge-linux-x64
- [x] T010 ÔÚ `src/JellyfinSuite.Plugin/PluginServiceRegistrator.cs` ×¢²á FrameExportService Îªµ¥Àı

**Checkpoint**: `make build-frame-forge` ²ú³ö¶ş½øÖÆ£»CI build.yml ÂÌ£»release.yml zip º¬ frame-forge-linux-x64

---

## Phase 2: Foundational ¡ª Rust daemon ºËĞÄ + C# Í¨ĞÅ²ã + Ç°¶ËÈë¿Ú

**Purpose**: ÊµÏÖ Rust daemon µÄ Unix socket ·şÎñ¡¢Ğ­ÒéÖ¡½âÎö¡¢µ¥Ö¡½âÂë+ÖÊÁ¿¼ì²âÁ÷Ë®Ïß£»C# ½ø³Ì¹ÜÀíÓë socket Á¬½Ó£»Ç°¶Ë injector ×¢ÈëÖ¡µ¼³ö°´Å¥µ½ OSD¡£

**?? CRITICAL**: ËùÓĞ User Story ÒÀÀµ´Ë Phase Íê³É¡£

### Rust ¡ª Socket + Ğ­Òé + µ¥Ö¡½âÂë

- [x] T011 ÔÚ `src/frame-forge/src/main.rs` ÊµÏÖ Unix socket ·şÎñ¶Ë£¨`tokio::net::UnixListener`£©£»socket Â·¾¶ÓÉÃüÁîĞĞ²ÎÊı´«Èë£»Æô¶¯Ê±µ÷ÓÃ `opencv::core::ocl::haveOpenCL()` ¼ì²â GPU ¿ÉÓÃĞÔ²¢ÉèÖÃÈ«¾Ö flag£¨ÓÃÓÚºóĞø Warp/Blending ½×¶Î¾ö²ß£©
- [x] T011b [P] ÔÚ `src/frame-forge/src/main.rs` ÊµÏÖ `FrameCache` ½á¹¹Ìå£º`LruCache<(PathBuf, i64), Arc<DynamicImage>>`£¨100 ÌõÉÏÏŞ£©£¬key=(canonical_path, pos_ms/500*500)£»±©Â¶ `fn get_or_insert(path, pos_ms) -> Arc<DynamicImage>`£¬ÄÚ²¿Ëø±£»¤£¬¹© handle_animate/handle_stitch ¹²ÏíÊ¹ÓÃ
- [x] T012 [P] ÔÚ `src/frame-forge/src/protocol.rs` ÊµÏÖ¶ş½øÖÆĞ­ÒéÖ¡¶ÁĞ´º¯Êı£º`read_msg_type`¡¢`read_single_frame_req`¡¢`read_animate_req`¡¢`read_stitch_req`¡¢`write_jpeg_response`¡¢`write_progress_event`£¨²Î¿¼ seek-preview `protocol.rs` Ä£Ê½£©
- [x] T013 [P] ÔÚ `src/frame-forge/src/decoder.rs` ´Ó seek-preview µÄ `decoder.rs` ¸´ÖÆ/ÊÊÅäºËĞÄÂß¼­£ºffmpeg-next ´ò¿ªÎÄ¼ş + ¶¨Î»¹Ø¼üÖ¡ + ½âÂëÎª RGB + width=0 ·µ»ØÔ­Í¼ / width>0 ÓÃ Lanczos3 Ëõ·Å + JPEG ±àÂë
- [x] T014 [P] ÔÚ `src/frame-forge/src/quality.rs` ÊµÏÖÖ¡ÖÊÁ¿¼ì²â£ºÁÁ¶ÈÖ±·½Í¼·½²î£¨ºÚ/°×Ö¡£©¡¢3x3 Laplacian ·½²î£¨Ä£ºıÖ¡£©¡¢Ö¡¼äÏñËØ²îÒì±È£¨×ª³¡¼ì²â£©£»·µ»Ø `QualityFlags` bitmask + ÎÄ×Ö±êÇ©
- [x] T015 ÔÚ `src/frame-forge/src/main.rs` ÊµÏÖ `handle_single_frame` ÇëÇó´¦Àí£º½âÂë(Ô­Í¼»òËõÂÔÍ¼) ¡ú ÖÊÁ¿¼ì²â ¡ú ·µ»Ø JPEG + quality_flags
- [x] T016 [P] ÔÚ `src/frame-forge/src/resources.rs` ÊµÏÖ CPU/ÄÚ´æ¼à¿Ø£º¶ÁÈ¡ `/proc/stat` + `/proc/meminfo` ¡ú ¼ÆËã CPU Ê¹ÓÃÂÊºÍ¿ÉÓÃÄÚ´æ°Ù·Ö±È£»±©Â¶ `fn resource_pressure() -> f64` (0=¿ÕÏĞ, 1=±¥ºÍ)

### C# ¡ª ½ø³Ì¹ÜÀí + Socket Á¬½Ó

- [x] T017 ÔÚ `src/JellyfinSuite.Plugin/Services/FrameExportService.cs` ÊµÏÖ½ø³Ì¹ÜÀí£º$env:SPECIFY_FEATURE = "009-frame-forge-stitch" ; StartAsync Æô¶¯ frame-forge-linux-x64 ×Ó½ø³Ì£¨Process.Start + Unix socket Â·¾¶²ÎÊı£©¡¢StopAsync ÓÅÑÅ¹Ø±Õ¡¢½ø³ÌÍË³öÊ± 3s ºó×Ô¶¯ÖØÁ¬
- [x] T018 ÔÚ `src/JellyfinSuite.Plugin/Services/FrameExportService.cs` ÊµÏÖ Unix socket Á¬½Ó£º`Socket(AddressFamily.Unix)` + `SemaphoreSlim(1,1)` ±£»¤Ğ´Èë + `ReceiveBytesAsync` ¾«È·¶ÁÈ¡ÏìÓ¦
- [x] T019 ÔÚ `src/JellyfinSuite.Plugin/Services/FrameExportService.cs` ÊµÏÖ `GetFrameAsync(string filePath, long posMs, int width, Guid itemId, CancellationToken ct)` ¡ú ·¢ËÍ 0x10 SINGLE_FRAME ÇëÇó ¡ú ·µ»Ø `(byte[] jpeg, QualityFlags flags)`

### Ç°¶Ë ¡ª OSD °´Å¥×¢Èë

- [x] T020 ÔÚ `src/player-enhancer/src/icons.ts` ĞÂÔöÖ¡µ¼³ö°´Å¥ SVG Í¼±ê `ICON_FRAME_EXPORT`£¨½¨ÒéÓÃ½ºÆ¬¸ñ»òÍø¸ñÍ¼±ê£©
- [x] T021 ĞŞ¸Ä `src/player-enhancer/src/injector.ts`£ºÔÚ `injectPlayerButtons` ÖĞĞÂÔöÖ¡µ¼³ö°´Å¥£¨¸½ÔÚ½ØÍ¼°´Å¥ºó·½£©£¬°ó¶¨ click ¡ú ´ò¿ªÖ¡µ¼³ö Modal£¨Ô¤Áô `openFrameExportModal()` stub£¬¾ßÌåÊµÏÖÔÚ US1 ÈÎÎñ£©
- [x] T022 ĞŞ¸Ä `src/player-enhancer/src/styles.ts`£ºÈ«Á¿Ç¨ÒÆµ½ @alivecss/aliveui CSS ¿ò¼Ü¡ª¡ªÉ¾³ıËùÓĞ×Ô¶¨Òå CSS£¬¸ÄÎª `import '@alivecss/aliveui/css'` + ÒıÈë @alivecss/aliveui Ö÷Ìâ±äÁ¿£»±£Áô CSS ×¢ÈëÈë¿Úº¯Êı `injectStyles()`

**Checkpoint**: `GET /JellyfinSuite/FrameExport/{itemId}?positionMs=5000&width=320` ·µ»Ø JPEG ËõÂÔÍ¼£»OSD À¸³öÏÖĞÂ°´Å¥£»`styles.ts` Ê¹ÓÃ @alivecss/aliveui

---

## Phase 3: User Story 1 ¡ª ´ò¿ªÖ¡Ñ¡ÔñÆ÷ (Priority: P1) ?? MVP

**Goal**: ÓÃ»§µã»÷"Ö¡µ¼³ö"°´Å¥ºóµ¯³ö Modal£¬ÒÔÍø¸ñĞÎÊ½Õ¹Ê¾µ±Ç°²¥·Å½ø¶ÈÇ°ºó 11 Ö¡ËõÂÔÍ¼¡£

**Independent Test**: ²¥·ÅÈÎÒâÊÓÆµ£¬µã»÷"Ö¡µ¼³ö"°´Å¥£¬Modal µ¯³ö²¢ÏÔÊ¾ËõÂÔÍ¼Íø¸ñ£¬µã»÷ÕÚÕÖ¹Ø±Õ¡£

### Implementation

- [x] T023 [P] [US1] ÔÚ `src/player-enhancer/src/frame-forge.ts` ´´½¨ Modal ÈİÆ÷¿Ç£ºbody-level ¹Ì¶¨¶¨Î» + ÕÚÕÖ + @alivecss/aliveui modal ÑùÊ½ + ´ò¿ª/¹Ø±Õº¯Êı `openFrameExportModal()` / `closeFrameExportModal()` + ¹Ø±ÕÊ±ÔİÍ£ÊÓÆµ£¨¿ÉÇĞ»»Îª²»ÔİÍ££©
- [x] T024 [P] [US1] ÔÚ `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` ÊµÏÖµ¥Ö¡ËõÂÔÍ¼¶Ëµã£º`GET /FrameExport/{itemId}?positionMs=N&width=320` ¡ú µ÷ `_service.GetFrameAsync()` ¡ú `File(jpeg, "image/jpeg")` + `Response.Headers["X-Frame-Quality"]` ·µ»ØÖÊÁ¿ÔªÊı¾İ JSON
- [x] T025 [US1] ÔÚ `src/player-enhancer/src/frame-forge.ts` ÊµÏÖ³õÊ¼Ö¡¼ÓÔØ£º¼ÆËãµ±Ç°²¥·Å½ø¶ÈÇ°ºó 5 Ö¡µÄÊ±¼ä´ÁÁĞ±í ¡ú Promise.all fetch ËõÂÔÍ¼ ¡ú äÖÈ¾Íø¸ñ
- [x] T026 [P] [US1] ÔÚ `src/player-enhancer/src/frame-forge.ts` ÊµÏÖÍø¸ñäÖÈ¾º¯Êı£º»îÓÃ @alivecss/aliveui grid Àà (`grid grid-cols-4 gap-2` µÈ) + Ã¿¸ñÄÚº¬ `<img>` + Ê±¼ä´Á±êÇ©ÎÄ×Ö
- [x] T027 [US1] ÔÚ `src/player-enhancer/src/injector.ts` µÄÖ¡µ¼³ö°´Å¥ click handler µ÷ÓÃ `openFrameExportModal()`£º´«Èë videoEl¡¢getItemId()¡¢getServerAddress()¡¢getRawToken()
- [x] T028 [US1] ÔÚ `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` ÊµÏÖ±ß½ç´¦Àí£ºitemId ²»´æÔÚ/ÎŞ±¾µØÎÄ¼ş ¡ú 404£»daemon ²»¿ÉÓÃ ¡ú 503
- [x] T029 [US1] ĞŞ¸Ä `src/player-enhancer/src/i18n.ts`£ºĞÂÔö US1 Ïà¹Ø i18n key£¨zh/ja/en£©£º`frameExport.title`¡¢`frameExport.close`¡¢`frameExport.loading`

**Checkpoint**: Ö¡Ñ¡ÔñÆ÷ Modal ¿É´ò¿ª¡¢¼ÓÔØ 11 Ö¡ËõÂÔÍ¼¡¢¿É¹Ø±Õ£»¶Ëµã 404/503 ÕıÈ·´¦Àí

---

## Phase 4: User Story 2 ¡ª À©Õ¹»ñÈ¡¸ü¶à¹Ø¼üÖ¡ (Priority: P1)

**Goal**: Ö¡Ñ¡ÔñÆ÷ÖĞ"ÏòÇ°"ºÍ"Ïòºó"°´Å¥¿É×·¼Ó¸ü¶àÖ¡ËõÂÔÍ¼¡£

**Independent Test**: ÔÚÖ¡Ñ¡ÔñÆ÷ÖĞµã»÷"ÏòÇ°À©Õ¹"°´Å¥£¬½çÃæ×·¼Ó 10 Ö¡ËõÂÔÍ¼£»µã»÷"ÏòºóÀ©Õ¹"Í¬Àí£»µ½´ï±ß½çÊ±°´Å¥½ûÓÃ¡£

### Implementation

- [x] T030 [P] [US2] ÔÚ `src/player-enhancer/src/frame-forge.ts` ÊµÏÖ"ÏòÇ°"/"Ïòºó"Á½¸öÀ©Õ¹°´Å¥£¨@alivecss/aliveui btn ÑùÊ½ + ¼ıÍ·Í¼±ê£©£¬¼ÓÔØÖĞÏÔÊ¾ spinner + disabled
- [x] T031 [US2] ÔÚ `src/player-enhancer/src/frame-forge.ts` ÊµÏÖÀ©Õ¹Âß¼­£ºÎ¬»¤µ±Ç°ÏÔÊ¾Ö¡·¶Î§ `[minPosMs, maxPosMs]` ¡ú µã»÷À©Õ¹Ê±¼ÆËãĞÂ·¶Î§£¨Æ«ÒÆ N¡ÁM Ö¡¼ä¸ô£©¡ú fetch ĞÂÖ¡ ¡ú append µ½Íø¸ñÍ·²¿»òÎ²²¿ + ¹ö¶¯µ½ĞÂÔöÎ»ÖÃ
- [x] T032 [US2] ÊµÏÖÇëÇóºÏ²¢£¨debounce 300ms£©£º¿ìËÙÁ¬Ğøµã»÷À©Õ¹Ê±Ö»·¢ËÍ×îºóÒ»´ÎÇëÇó£¬±ÜÃâ DDOS ºó¶Ë
- [x] T033 [US2] ÊµÏÖ±ß½ç¼ì²â£ºvideoTime=0 Ê±½ûÓÃ"ÏòÇ°"°´Å¥£»videoTime¡İduration Ê±½ûÓÃ"Ïòºó"°´Å¥£»°´Å¥ÎÄ×Ö±ä»Ò + ÌáÊ¾ÎÄ×Ö£¨Èç"ÒÑµ½´ïÊÓÆµ¿ªÍ·"£©

**Checkpoint**: ¿É×ÔÓÉÇ°ºóä¯ÀÀÊÓÆµ¹Ø¼üÖ¡£¬±ß½ç´¦ÀíÕıÈ·

---

## Phase 5: User Story 3 ¡ª Ö¡Ñ¡ÔñÓëÔ¤ÀÀ (Priority: P1)

**Goal**: Ã¿Ö¡ËõÂÔÍ¼ÓĞ checkbox£¨Ä¬ÈÏ¹´Ñ¡£©£¬À¬»øÖ¡×Ô¶¯È¡Ïû¹´Ñ¡²¢±ê¼Ç£¬µ×²¿ÏÔÊ¾ÒÑÑ¡Ö¡Êı¡£

**Independent Test**: È¡Ïû²¿·ÖÖ¡¹´Ñ¡£¬µ×²¿¼ÆÊı¸üĞÂ£¬¹´Ñ¡»Ö¸´£»µã»÷ËõÂÔÍ¼·Å´óÔ¤ÀÀ¡£

### Implementation

- [x] T034 [P] [US3] ÔÚ `src/player-enhancer/src/frame-forge.ts` ÎªÃ¿Ö¡Ìí¼Ó checkbox£¨Ä¬ÈÏ checked£©¡ú onChange ¸üĞÂÑ¡ÖĞ×´Ì¬ + µ×²¿¹¤¾ßÀ¸¼ÆÊı `"ÒÑÑ¡ X/×ÜÊı Y Ö¡"`
- [x] T035 [P] [US3] ÊµÏÖÖ¡µã»÷·Å´óÔ¤ÀÀ£ºµã»÷ËõÂÔÍ¼£¨·Ç checkbox ÇøÓò£©¡ú ÔÚÔ­Î»»ò lightbox ÖĞÕ¹Ê¾´óÍ¼£¨µ÷ GET ¶Ëµã width=0 »ñÈ¡Ô­Í¼£©+ ÏÔÊ¾Ê±¼ä´Á
- [x] T036 [US3] ½âÎö `X-Frame-Quality` ÏìÓ¦Í·£º`isJunk=true` µÄÖ¡×Ô¶¯È¡Ïû¹´Ñ¡ ¡ú UI Ìí¼ÓºìÉ«±ß¿ò + ±êÇ©ÎÄ×Ö£¨Èç "ºÚÖ¡"/"Ä£ºıÖ¡"£©¡ú Í¸Ã÷¶È½µµÍ
- [x] T037 [US3] ÊµÏÖÈ«Ñ¡/È«²»Ñ¡¿ì½İ²Ù×÷£ºµ×²¿¹¤¾ßÀ¸Ìí¼Ó"È«Ñ¡"/"È¡ÏûÈ«Ñ¡"Á´½Ó°´Å¥

**Checkpoint**: Ö¡Ñ¡ÔñÆ÷ MVP ¿É½»»¥¡ª¡ªä¯ÀÀ¡¢Ñ¡Ôñ¡¢Ô¤ÀÀÖ¡

---

## Phase 6: User Story 4 ¡ª µ¼³ö¶¯»­ GIF/WebP (Priority: P2)

**Goal**: ÓÃ»§ÅäÖÃ²ÎÊıºóµã»÷"Éú³É"£¬ºó¶ËÉú³É GIF/WebP ¶¯»­ÎÄ¼ş£¬Í¨¹ı SSE ±¨¸æ½ø¶È£¬³É¹ûÕ¹Ê¾ÔÚ Modal¡£

**Independent Test**: Ñ¡ 3 Ö¡£¬Ä¬ÈÏ²ÎÊı£¬µã»÷Éú³É ¡ú SSE ½ø¶È ¡ú Modal Õ¹Ê¾¶¯»­Ô¤ÀÀ ¡ú ÏÂÔØÎÄ¼ş¡£

### Rust ¡ª ¶¯»­±àÂë

- [x] T038 [P] [US4] ÔÚ `src/frame-forge/src/animate.rs` ÊµÏÖ GIF ±àÂëº¯Êı `encode_gif(frames: Vec<DynamicImage>, fps: u16, loop_count: u16) -> Vec<u8>`£ºÊ¹ÓÃ `gif` crate ±àÂë£¬µ÷É«°åÁ¿»¯Îª 256 É«
- [x] T039 [P] [US4] ÔÚ `src/frame-forge/src/animate.rs` ÊµÏÖ WebP ±àÂëº¯Êı `encode_webp_anim(frames: Vec<DynamicImage>, fps: u16, loop_count: u16) -> Vec<u8>`£ºÊ¹ÓÃ `webp` crate ¶¯»­±àÂë
- [x] T040 [US4] ÔÚ `src/frame-forge/src/animate.rs` ÊµÏÖËõ·ÅÂß¼­£º¸ù¾İ `resizeMode`("width"/"height") + `customWidth/customHeight` »ò `resolutionPreset` ¡ú `image::imageops::resize`(Lanczos3) µÈ±ÈËõ·ÅÃ¿Ö¡
- [x] T041 [US4] ÔÚ `src/frame-forge/src/main.rs` ÊµÏÖ `handle_animate` ÇëÇó£ºÖğÖ¡½âÂëÔ­Í¼(width=0) ¡ú ÖÊÁ¿¼ì²â(Ìø¹ı,½ö¼ÇÂ¼) ¡ú Ëõ·Å ¡ú push Ö¡»º³å ¡ú µ÷ÓÃ encode_xxx ¡ú Ã¿Ö¡Íê³ÉÍÆËÍ progress event ¡ú ×îÖÕ·µ»Ø±àÂë×Ö½Ú

### C# ¡ª ÈÎÎñ¹ÜÀí + Éú³É¶Ëµã

- [x] T042 [P] [US4] ÔÚ `src/JellyfinSuite.Plugin/Services/FrameExportTaskManager.cs` ÊµÏÖÈÎÎñ×Öµä£º`ConcurrentDictionary<taskId, TaskState>` + ÈÎÎñ×´Ì¬Ã¶¾Ù (pending¡úrunning¡úcomplete/error/cancelled) + Ã¿ÈÎÎñ³ÖÓĞ `Channel<TaskProgress>` ÓÃÓÚ SSE ÇÅ½Ó
- [x] T043 [US4] ÔÚ `src/JellyfinSuite.Plugin/Services/FrameExportService.cs` ÊµÏÖ `SubmitAnimateTask(GenerateRequest req) -> taskId`£ºÉú³É UUID ¡ú ´´½¨ TaskState ¡ú Ğ´Èë `{tempDir}/{taskId}/` ¡ú ±éÀú frames µ÷ Rust GetFrameAsync »º´æÔ­Ê¼Ö¡µ½´ÅÅÌ ¡ú µ÷ Rust handle_animate ¡ú Ğ´ output ÎÄ¼ş ¡ú Éè status=complete
- [x] T044 [P] [US4] ÔÚ `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` ÊµÏÖ `POST /FrameExport/Generate` ¶Ëµã£ºÑéÖ¤ params£¨fps 1-30, ÖÁÉÙ 2 Ö¡£©¡ú `_service.SubmitAnimateTask()` ¡ú 202 { taskId }
- [x] T045 [P] [US4] ÔÚ `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` ÊµÏÖ `GET /FrameExport/Result/{taskId}/{filename}` ¶Ëµã£ºÎÄ¼ş´æÔÚÇÒ status=complete ¡ú File(bytes, content-type) + Content-Disposition ÏÂÔØÍ·
- [x] T046 [P] [US4] ÔÚ `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` ÊµÏÖ `DELETE /FrameExport/Result/{taskId}` ¶Ëµã£º`Directory.Delete(tempDir, recursive)` + ÒÆ³ı×Öµä¼ÇÂ¼ ¡ú 200
- [x] T047 [P] [US4] ÔÚ `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` ÊµÏÖ `POST /FrameExport/Cancel/{taskId}` ¶Ëµã£ºµ÷ Process.Kill() + WaitForExit(3000) + `rm -rf tempDir` + status=cancelled ¡ú 200
- [x] T048 [P] [US4] ÔÚ `src/JellyfinSuite.Plugin/Services/FrameExportTaskManager.cs` ÊµÏÖ 5 ·ÖÖÓ¶¨Ê±ÇåÀí£º`Timer` ¡ú ±éÀú×Öµä ¡ú createdAt+5min ¹ıÆÚ ¡ú `Directory.Delete(tempDir, recursive)` + ÒÆ³ı¼ÇÂ¼
- [x] T049 [P] [US4] ÔÚ `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` ÊµÏÖ `GET /FrameExport/Health` ¶Ëµã£º·µ»Ø daemon ¿ÉÓÃ×´Ì¬ + »îÔ¾ÈÎÎñÊı + CPU/ÄÚ´æÊ¹ÓÃÂÊ

**Checkpoint**: cURL ²âÊÔ Generate ¡ú Progress(SSE) ¡ú Result download È«Á÷³ÌÍ¨¹ı

---

## Phase 7: User Story 7 ¡ª SSE ½ø¶ÈÓë³É¹û¹ÜÀí (Priority: P2)

**Goal**: Ç°¶ËÍ¨¹ı SSE ½ÓÊÕ½ø¶ÈÊÂ¼ş£¬Õ¹Ê¾½ø¶ÈÌõºÍ²½ÖèÎÄ×Ö£»Íê³Éºó×Ô¶¯Õ¹Ê¾³É¹ûÔ¤ÀÀ£¨¶¯»­Ñ­»·²¥·Å£©£¬³É¹ûÒ³Ìá¹©ÏÂÔØ/É¾³ı/·µ»Ø²Ù×÷¡£

**Independent Test**: µã»÷Éú³É ¡ú ½ø¶ÈÌõÖğ²½Ôö³¤ ¡ú Íê³Éºó×Ô¶¯Ìø³É¹ûÔ¤ÀÀ ¡ú µã»÷ÏÂÔØ»ñµÃÕıÈ·ÎÄ¼ş¡£

### Ç°¶Ë ¡ª SSE + ½ø¶ÈÒ³ + ³É¹ûÒ³

- [x] T050 [P] [US7] ÔÚ `src/player-enhancer/src/frame-progress.ts` ÊµÏÖ SSE ½ø¶ÈÁ¬½Ó£º`new EventSource(url)` ¡ú `onmessage` ½âÎö JSON ¡ú ¸üĞÂ½ø¶È×´Ì¬£»`onerror` ×Ô¶¯ÖØÁ¬(×î¶à3´Î, ¼ä¸ô1s)
- [x] T051 [US7] ÔÚ `src/player-enhancer/src/frame-progress.ts` ÊµÏÖ½ø¶È UI£º¶¥²¿½ø¶ÈÌõ(@alivecss/aliveui progress) + °Ù·Ö±ÈÎÄ×Ö + µ±Ç°²½ÖèÃèÊöÎÄ×Ö(phase¡úi18n Ó³Éä£º"decoding"¡ú"½âÂëÖĞ"¡¢"encoding"¡ú"±àÂëÖĞ"¡¢"matching"¡ú"ÌØÕ÷Æ¥ÅäÖĞ"µÈ)
- [x] T052 [P] [US7] ÔÚ `src/player-enhancer/src/frame-result.ts` ÊµÏÖ³É¹ûÔ¤ÀÀÒ³£º¶¯»­ `<img>` ÔªËØ¼ÓÔØ resultUrl Ñ­»·²¥·Å£»È«¾°Í¼ `<img>` ÊÊÅäÈİÆ÷ + ÍÏ¶¯/Ëõ·Å£»ÏÔÊ¾ fileSize£¨¸ñÊ½»¯Îª KB/MB£©
- [x] T053 [P] [US7] ÔÚ `src/player-enhancer/src/frame-result.ts` ÊµÏÖ"ÏÂÔØ"°´Å¥£º`window.open(resultUrl)` ´¥·¢ä¯ÀÀÆ÷ÏÂÔØ£»"É¾³ı"°´Å¥£º`DELETE /FrameExport/Result/{taskId}` ¡ú ÇåÀí³É¹¦ ¡ú ·µ»ØÍø¸ñÒ³£»"·µ»Ø"°´Å¥£ºµ÷ delete + ·µ»ØÍø¸ñÒ³
- [x] T054 [US7] ÔÚ `src/player-enhancer/src/frame-forge.ts` ÊµÏÖÒ³ÃæÇĞ»»Âß¼­£ºÍø¸ñÒ³ ¡ú Ìá½» Generate ¡ú ÇĞ»»µ½½ø¶ÈÒ³(T050+T051) ¡ú status=complete ¡ú ÇĞ»»µ½³É¹ûÒ³(T052+T053)
- [x] T055 [US7] ÔÚ `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` ÊµÏÖ SSE ¶Ëµã£º`GET /FrameExport/Progress?taskId={uuid}` ¡ú `Response.ContentType = "text/event-stream"` ¡ú `ChannelReader.ReadAllAsync` ¡ú `"data: {json}\n\n"` ¡ú channel ¹Ø±ÕÊ±¶Ï¿ªÁ¬½Ó

**Checkpoint**: ¶Ëµ½¶Ë SSE Á÷³Ì¡ª¡ªÌá½»ÈÎÎñ ¡ú ÊµÊ±½ø¶È ¡ú ³É¹ûÔ¤ÀÀ ¡ú ÏÂÔØ/É¾³ı/·µ»Ø

---

## Phase 8: User Story 6 ¡ª µ¼³ö²ÎÊıÅäÖÃÓë³Ö¾Ã»¯ (Priority: P2)

**Goal**: ¸ñÊ½ÏÂÀ­²Ëµ¥¡¢·Ö±æÂÊÔ¼Êø£¨¿í/¸ß»¥³â+Ô¤ÉèµµÎ»£©¡¢Ö¡ÂÊ»¬¿é¡¢Ñ­»·´ÎÊıÊäÈë¡£ËùÓĞ²ÎÊı×Ô¶¯ localStorage ³Ö¾Ã»¯¡£

**Independent Test**: ĞŞ¸ÄÖ¡ÂÊ 15fps¡¢·Ö±æÂÊ 720p ¡ú ¹Ø±Õ Modal ¡ú ÔÙ´ò¿ª ¡ú ²ÎÊı»Ö¸´¡£

### Implementation

- [x] T056 [P] [US6] ÔÚ `src/player-enhancer/src/frame-params.ts` ÊµÏÖ `LocalExportSettings` ÀàĞÍ + `loadSettings(): LocalExportSettings` / `saveSettings(s: LocalExportSettings)` º¯Êı£¨localStorage key: `jfs-frameexport-settings`£¬Ä¬ÈÏÖµ£ºGIF/PNG¡¢width¡¢original¡¢5fps¡¢infinite loop£©
- [x] T057 [US6] ÔÚ `src/player-enhancer/src/frame-forge.ts` µ×²¿¹¤¾ßÀ¸ÊµÏÖ¸ñÊ½ÏÂÀ­²Ëµ¥£¨@alivecss/aliveui dropdown£©£º¶¯»­Ä£Ê½ÏÂ GIF/WebP Ñ¡Ïî¡¢È«¾°Í¼Ä£Ê½ÏÂ PNG/WebP-lossless Ñ¡Ïî£»Ä¬ÈÏÖµ´Ó localStorage ¶ÁÈ¡
- [x] T058 [P] [US6] ÔÚ `src/player-enhancer/src/frame-params.ts` ÊµÏÖ²ÎÊıÃæ°å×é¼ş£¨ÕÛµşÊ½ @alivecss/aliveui details/summary£©£º·Ö±æÂÊÔ¼ÊøÄ£Ê½ÇĞ»»£¨"°´¿í¶È"/"°´¸ß¶È" radio£©+ ×Ô¶¨ÒåÏñËØÊäÈë£¨Ò»¸ö¿É±à¼­£¬ÁíÒ»¸ö×Ô¶¯¼ÆËã²¢ÖÃ»Ò£©+ Ô¤ÉèµµÎ»ÏÂÀ­£¨Ñ¡Ôñºó×Ô¶¯ÇĞ»Ø"°´¿í¶È"£©+ Ö¡ÂÊ»¬¿é(1-30) + Ñ­»·´ÎÊıÊäÈë(0-99)
- [x] T059 [US6] ÊµÏÖ²ÎÊıÁª¶¯Âß¼­£º`resizeMode` ÇĞ»» ¡ú ÁíÒ»ÊäÈë¿ò×Ô¶¯¼ÆËã(±£³Ö¿í¸ß±È) + ÖÃ»Ò disabled£»Ô¤ÉèµµÎ»Ñ¡Ôñ ¡ú ×Ô¶¯ÇĞ resizeMode="width" + ÌîÔ¤ÉèÖµ£»¶¯»­Ä£Ê½ÏÂÒş²ØÖ¡ÂÊ/Ñ­»·´ÎÊıÍâµÄÆ´½ÓÏà¹Ø²ÎÊı
- [x] T060 [US6] ÊµÏÖ²ÎÊı±ä¸ü ¡ú ×Ô¶¯ `saveSettings()` + `Generate` ÇëÇó body ¶ÁÈ¡µ±Ç° params

**Checkpoint**: ËùÓĞ²ÎÊı¿Éµ÷½Ú¡¢×Ô¶¯³Ö¾Ã»¯¡¢¿í¸ß»¥³âÁª¶¯ÕıÈ·

---

## Phase 9: User Story 8 ¡ª ¶àÒ³Ãæ Modal µ¼º½ (Priority: P3)

**Goal**: Modal ÄÚÈıÒ³ÃæÕ»½á¹¹£¨Íø¸ñÒ³ ¡ú ½ø¶ÈÒ³ ¡ú ³É¹ûÒ³£©£¬¶¥²¿µ¼º½À¸ËæÒ³ÃæÇĞ»»±ä»¯¡£

**Independent Test**: Íø¸ñÒ³ ¡ú µã»÷Éú³É ¡ú ½ø¶ÈÒ³ ¡ú Íê³É ¡ú ³É¹ûÒ³ ¡ú ·µ»Ø ¡ú Íø¸ñÒ³¡£

### Implementation

- [x] T061 [P] [US8] ÔÚ `src/player-enhancer/src/frame-forge.ts` ÊµÏÖÒ³ÃæÕ»¹ÜÀí£º`currentPage: "grid" | "progress" | "result"` + `navigateTo(page, ...)` º¯Êı + Ò³ÃæÇĞ»»Ê±ÏÔÊ¾/Òş²Ø¶ÔÓ¦ DOM ÈİÆ÷
- [x] T062 [P] [US8] ÊµÏÖ¶¥²¿µ¼º½À¸äÖÈ¾º¯Êı£ºÍø¸ñÒ³ ¡ú ±êÌâ"Ö¡µ¼³ö" + X ¹Ø±Õ°´Å¥£»½ø¶ÈÒ³ ¡ú ±êÌâ"Éú³ÉÖĞ" + È¡Ïû°´Å¥£»³É¹ûÒ³ ¡ú ±êÌâ"Ô¤ÀÀ" + ·µ»Ø°´Å¥(¡û) + X ¹Ø±Õ°´Å¥
- [x] T063 [US8] ÊµÏÖÈ¡Ïû°´Å¥Âß¼­£ºµ÷ `POST /FrameExport/Cancel/{taskId}` ¡ú µ¼º½»ØÍø¸ñÒ³
- [x] T064 [US8] ÊµÏÖ Modal ¹Ø±ÕÊ±ÇåÀí£ºµ÷ `DELETE /FrameExport/Result/{taskId}`£¨ÈçÓĞ»îÔ¾ÈÎÎñ£©¡ú ÒÆ³ı Modal DOM

**Checkpoint**: ÈıÒ³Ãæµ¼º½Á÷³©£»È¡Ïû¡¢·µ»Ø¡¢¹Ø±Õ°´Å¥¾ùÕıÈ·ÇåÀí×ÊÔ´

---

## Phase 10: User Story 5 ¡ª µ¼³öÈ«¾°Í¼ (Priority: P3)

**Goal**: ÓÃ»§Ñ¡Ö¡ºóµã»÷"µ¼³öÈ«¾°Í¼"£¬Rust ¶Ë°´³¡¾°·ÖÀà×ß¶ÔÓ¦Ëã·¨Â·¾¶£¬SSE ±¨¸æ½ø¶È£¬Íê³ÉºóÕ¹Ê¾È«¾°Ô¤ÀÀ¡£

**Independent Test**: Ñ¡ 3 Ö¡Í¬³¡¾°Ö¡ ¡ú µã»÷µ¼³öÈ«¾°Í¼ ¡ú SSE ½ø¶È ¡ú Modal Õ¹Ê¾È«¾° ¡ú ÏÂÔØ PNG¡£

### Rust ¡ª ³¡¾°·ÖÀàÆ÷

- [x] T065 [P] [US5] ÔÚ `src/frame-forge/src/scene_classifier.rs` ÊµÏÖ³¡¾°·ÖÀàÆ÷£ºÊäÈë¶àÖ¡ ¡ú ¼ÆËãÑÕÉ«ìØ(`imageproc::stats::histogram` ¡ú entropy)¡¢Canny ±ßÔµÃÜ¶È(`imageproc::edges::canny` ¡ú count_nonzero/total_pixels)¡¢Ö¡¼ä²î·ÖÔË¶¯ÇøÓòÕ¼±È ¡ú ·ÖÀàÎª anime/landscape/liveaction
- [x] T066 [P] [US5] ÔÚ `src/frame-forge/src/scene_classifier.rs` ÊµÏÖ¾µÍ·ÔË¶¯ÀàĞÍÔ¤¼ì£ºÇ°Á½Ö¡¼ä¹ÀËãÖ÷µ¼ÔË¶¯(pan/zoom/rotation/static) + Æ´½Ó·½Ïò(horizontal/vertical)

### Rust ¡ª ³¡¾° A: ¶¯Âş Phase Correlation

- [x] T067 [P] [US5] ÔÚ `src/frame-forge/src/stitch_anime.rs` ÊµÏÖ Phase Correlation Æ´½Ó£º»Ò¶È»¯ + ººÃ÷´°¼ÓÈ¨ ¡ú 2D FFT(rustfft) ¡ú ¹éÒ»»¯»¥¹¦ÂÊÆ× ¡ú IFFT ¡ú ·åÖµ¶¨Î»(Å×ÎïÏß²åÖµÑÇÏñËØ) ¡ú (dx, dy) Æ½ÒÆ ¡ú Ö±½Ó warp Æ´½Ó
- [x] T068 [US5] ÔÚ `src/frame-forge/src/stitch_anime.rs` ÊµÏÖ¶àÖ¡ÔöÁ¿Æ´½Ó£º»ù×¼Ö¡(Ê×Ö¡) ¡ú ÏàÁÚÖ¡Öğ¶Ô¼ÆËã PhaseCorr ¡ú ÀÛ»ıÆ½ÒÆÆ«ÒÆ ¡ú Æ´½Ó + ¸üĞÂ»ù×¼

### Rust ¡ª ³¡¾° B: ·ç¾° AKAZE + Phase Correlation ¶µµ×

- [x] T069 [P] [US5] ÔÚ `src/frame-forge/src/stitch_landscape.rs` ÊµÏÖ¸ßÎÆÀí ROI ÑÚÂëÌáÈ¡£ºÌİ¶È·ùÖµÍ¼(`imageproc::gradients`) ¡ú ãĞÖµ·Ö¸î ¡ú ROI ÑÚÂë
- [x] T070 [US5] ÔÚ `src/frame-forge/src/stitch_landscape.rs` ÊµÏÖ AKAZE + RANSAC Homography£¨opencv crate£©£º½öÔÚ ROI ÄÚ×ö AKAZE ¼ì²â ¡ú BFMatcher(Hamming) ¡ú findHomography(RANSAC, threshold=3.0) ¡ú ÈôÄÚµãÊı<4 ¡ú ½µ¼¶µ½ Phase Correlation
- [x] T071 [P] [US5] ÔÚ `src/frame-forge/src/stitch_landscape.rs` ÊµÏÖ¿í»­·ù(FrameCount>5)ÖùÃæÍ¶Ó°£ºÓÃ opencv warp ÖùÃæ±ä»»´úÌæÆ½Ãæ Homography

### Rust ¡ª ³¡¾° C: ÕæÈË Ö¡²îÑÚÂë + AKAZE

- [x] T072 [P] [US5] ÔÚ `src/frame-forge/src/stitch_liveaction.rs` ÊµÏÖÖ¡²îÔË¶¯ÑÚÂë£ºÏàÁÚÖ¡²î·Ö ¡ú ĞÎÌ¬Ñ§ÅòÕÍ(3x3 kernel, 2 iterations) ¡ú ÔË¶¯ÇøÓòÑÚÂë
- [x] T073 [US5] ÔÚ `src/frame-forge/src/stitch_liveaction.rs` ÊµÏÖÑÚÂë¹ıÂË AKAZE + RANSAC£ºÈ«Í¼ AKAZE ¼ì²â ¡ú ¹ıÂËµôÂäÈëÔË¶¯ÑÚÂëµÄ¹Ø¼üµã ¡ú ¶ÔÊ£Óà¾²Ì¬±³¾°µã×ö RANSAC Homography ¡ú Á¬Ğø N Ö¡ Homography È¡·ÖÁ¿ÖĞÖµ(Â³°ô¾ÛºÏ)
- [x] T074 [P] [US5] ÔÚ `src/frame-forge/src/stitch_liveaction.rs` ÊµÏÖ±³¾°ÇøÓò warp + Ç°¾°ÇøÓòË«ÏßĞÔ²åÖµÌî³ä

### Rust ¡ª »ìºÏ + Ö÷Á÷³Ì

- [x] T075 [P] [US5] ÔÚ `src/frame-forge/src/blender.rs` ÊµÏÖÔöÒæ²¹³¥£º¼ÆËãÖØµşÇøÓòÆ½¾ùÁÁ¶È±È ¡ú È«¾ÖÔöÒæµ÷ÕûÏû³ıÖ¡¼äÉ«²î
- [x] T076 [US5] ÔÚ `src/frame-forge/src/blender.rs` ÊµÏÖ Laplacian ½ğ×ÖËş¶àÆµ´ø»ìºÏ£º¹¹½¨ 4 ²ã¸ßË¹½ğ×ÖËş + Laplacian ½ğ×ÖËş ¡ú Ã¿²ã¼ÓÈ¨Æ½¾ù(È¨ÖØ=¾àÖ¡±ß½çµÄ¾àÀë) ¡ú ÖØ½¨ºÏ³ÉÍ¼Ïñ
- [x] T077 [US5] ÔÚ `src/frame-forge/src/main.rs` ÊµÏÖ `handle_stitch` ÇëÇó£º½âÂëÔ­Í¼ ¡ú ½üÖØ¸´Ö¡ÌŞ³ı(pHash ÏàËÆ¶È¼ì²â£¬±ê¼ÇÈßÓàÖ¡) ¡ú ³¡¾°·ÖÀàÆ÷ ¡ú route µ½ stitch_anime/stitch_landscape/stitch_liveaction ¡ú ÔöÒæ²¹³¥ + Blender ¡ú °´ format(PNG/WebP-lossless)±àÂë ¡ú Ã¿½×¶ÎÍÆËÍ progress event ¡ú ×îÖÕ·µ»ØÊä³ö×Ö½Ú
- [x] T078 [P] [US5] ÔÚ `src/frame-forge/src/main.rs` ÊµÏÖ½üÖØ¸´Ö¡¼ì²â(pHash)£º`image::imageops::resize(8x8)` ¡ú »Ò¶È»¯ ¡ú DCT ¡ú ±È½ÏººÃ÷¾àÀë ¡ú similarity>90% ±ê¼ÇÈßÓà

### C# ¡ª È«¾°ÈÎÎñÌá½»

- [x] T079 [US5] ÔÚ `src/JellyfinSuite.Plugin/Services/FrameExportService.cs` ÊµÏÖ `SubmitStitchTask(GenerateRequest req) -> taskId`£ºÍ¬ SubmitAnimateTask Ä£Ê½£¬µ÷ Rust handle_stitch Â·¾¶
- [x] T080 [US5] ÔÚ `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` µÄ `POST /FrameExport/Generate` ¶ËµãÔö¼Ó `type: "stitch"` Â·¾¶·Ö·¢

### Ç°¶Ë ¡ª È«¾°µ¼³ö UI

- [x] T081 [US5] ÔÚ `src/player-enhancer/src/frame-forge.ts` µ×²¿¹¤¾ßÀ¸Ìí¼Ó"µ¼³öÈ«¾°Í¼"°´Å¥£¨Óë"µ¼³ö¶¯»­"²¢ÁĞ»òÔÚÄ£Ê½ÏÂÇĞ»»£©
- [x] T082 [US5] ÔÚ `src/player-enhancer/src/frame-result.ts` È«¾°Í¼³É¹ûÕ¹Ê¾£º`<img>` ´óÍ¼ÊÊÅäÈİÆ÷ + `object-fit: contain` + ¿ÉÍÏ¶¯/Ëõ·Å£¨Èç¹û @alivecss/aliveui ²»Ìá¹©£¬ÓÃ¼òµ¥µÄ CSS `overflow: auto` ÈİÆ÷£©

**Checkpoint**: È«¾°Æ´½Ó¶Ëµ½¶Ë¡ª¡ª¶¯Âş×ß PhaseCorr¡¢·ç¾°×ß AKAZE+PhaseCorr ¶µµ×¡¢ÕæÈË×ßÖ¡²î+AKAZE£»SSE ±¨¸æ¸÷½×¶Î½ø¶È

---

## Phase 11: Polish & Cross-Cutting Concerns

**Purpose**: ÈıÓï i18n ²¹Æë¡¢´íÎó´¦ÀíÍêÉÆ¡¢×ÊÔ´µ÷¶È¼¯³É¡¢DRM ¼ì²é¡¢README ¸üĞÂ¡¢¶Ëµ½¶ËÑéÖ¤¡£

- [x] T083 [P] ²¹È« `src/player-enhancer/src/i18n.ts` ËùÓĞĞÂÔö UI ÎÄ×ÖµÄÈıÓï·­Òë£¨zh/ja/en£©£ºframeExport ÏÂËùÓĞÒ³ÃæµÄ±êÌâ¡¢°´Å¥¡¢×´Ì¬ÎÄ×Ö£»ÖÊÁ¿±êÇ©("ºÚÖ¡"/"Ä£ºıÖ¡")£»½ø¶È½×¶ÎÎÄ×Ö
- [x] T084 [P] Ç°¶Ë´íÎó´¦ÀíÍêÉÆ£ºÍøÂç³¬Ê±ÌáÊ¾¡¢SSE ÖØÁ¬´ÎÊıºÄ¾¡ÌáÊ¾¡¢Éú³É´íÎó retry Âß¼­
- [x] T085 ÔÚ `src/frame-forge/src/resources.rs` ¼¯³É×ÊÔ´¸ĞÖªµ÷¶Èµ½ `handle_animate` / `handle_stitch`£º`resource_pressure() > 0.8`£¨¼´ CPU>80% »ò ¿ÉÓÃÄÚ´æ <512MB Ê±µÄÊä³öÖµ£©Ê± Semaphore ×èÈûĞÂÈÎÎñ£¬ÓÅÏÈ±£ÕÏ seek-preview ÑÓ³Ù<50ms
- [x] T086 [P] ÔÚ `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` ËùÓĞ¶ËµãÌí¼Ó DRM ¼ì²é£¨Í¬ seek-preview ºÍ screenshot Ä£Ê½£©£ºitem.MediaStreams º¬ IsEncrypted ¡ú 403
- [x] T087 [P] ÔÚ `src/JellyfinSuite.Plugin/Services/FrameExportTaskManager.cs` ÊµÏÖ EntryPoint ÖĞ¹Â¶ùÄ¿Â¼ÇåÀí£º·şÎñÆô¶¯Ê± `Directory.Delete("temp/frame-forge", recursive)` ¡ú `Directory.CreateDirectory`
- [x] T088 [P] ÔËĞĞ `make test`£ºÈ·ÈÏ Rust + TypeScript + C# È«Ì×²âÊÔÍ¨¹ı
- [ ] T089 `make update` ²¿Êğµ½ jellyfin-dev ÈİÆ÷£¬ÊÖ¶¯¶Ëµ½¶ËÑéÖ¤£º
  - ´ò¿ªÊÓÆµ ¡ú µã»÷Ö¡µ¼³ö ¡ú ä¯ÀÀ/Ñ¡ÔñÖ¡
  - ¶¯»­µ¼³ö£ºÅäÖÃ²ÎÊı ¡ú Éú³É ¡ú SSE ½ø¶È ¡ú Ô¤ÀÀ ¡ú ÏÂÔØ GIF/WebP ÕıÈ·
  - È«¾°Æ´½Ó£ºÑ¡Í¬³¡¾°Ö¡ ¡ú µ¼³öÈ«¾°Í¼ ¡ú SSE ½×¶Î½ø¶È ¡ú Ô¤ÀÀ ¡ú ÏÂÔØ PNG/WebP-lossless ÕıÈ·
  - È¡ÏûÈÎÎñ ¡ú ×Ó½ø³Ì±»É± + ÁÙÊ±ÎÄ¼şÇåÀí
  - ¹Ø±Õ Modal ¡ú ÁÙÊ±ÎÄ¼şÇåÀí
  - ÎŞ±¾µØÂ·¾¶ÊÓÆµ ¡ú °´Å¥½ûÓÃ/404
  - CSS ÑéÖ¤£ºËùÓĞ UI Ê¹ÓÃ @alivecss/aliveui Àà£¬ÎŞ×Ô¶¨Òå CSS ²ĞÁô
- [ ] T090 [P] ¼ì²é `README.md` / `README.zh-CN.md` ÊÇ·ñĞèÒª¸üĞÂ£¨ĞÂ¹¦ÄÜ£ºÖ¡µ¼³öÓëÈ«¾°Æ´½Ó£©
- [x] T091 [P] ¸üĞÂ `src/player-enhancer/package.json` µÄ `dependencies`£¨@alivecss/aliveui °æ±¾¹Ì¶¨£©²¢¼ì²éÎŞ¶àÓàÒÀÀµ
- [x] T091b [P] ÔÚ `src/JellyfinSuite.Plugin/Controllers/FrameExportController.cs` ±©Â¶ÖÊÁ¿¼ì²âãĞÖµÅäÖÃ¶Ëµã£º`GET /FrameExport/QualityThresholds` ·µ»Øµ±Ç°ãĞÖµ JSON¡¢`PUT /FrameExport/QualityThresholds` ½ÓÊÕ `{ blackBrightnessVarMin, whiteBrightnessVarMax, blurLaplacianVarMin }` ¡ú ´æÓÚ C# ¾²Ì¬×Ö¶Î£¨·şÎñÖØÆô»Ö¸´Ä¬ÈÏÖµ£©£»ãĞÖµ´«µİµ½ Rust ¶ËÃ¿´Î SINGLE_FRAME ÇëÇóÊ±×÷Îª header ²ÎÊı
- [x] T091c ÊÖ¶¯ĞÔÄÜ´ï±êÑéÖ¤£ºËõÂÔÍ¼ 11 Ö¡ ¡Ü2s(SC-002)¡¢¶¯»­ 10f¡Á480p ¡Ü8s(SC-003)¡¢È«¾° 5f¡Á720p ¡Ü15s(SC-004)¡¢ºÚ/°×Ö¡¼ì²âÂÊ >95% + Ä£ºıÖ¡¼ì²âÂÊ >85%(SC-005)¡¢Æ´½Ó³É¹¦ÂÊ >80%(SC-006)¡¢SSE ÑÓ³Ù <500ms(SC-007)¡¢²ÎÊı³Ö¾Ã»¯»Ö¸´ 100%(SC-008)£»¼ÇÂ¼¶Ô±ÈÊı¾İĞ´Èë `specs/009-frame-forge-stitch/perf-validation.md`

---

## Phase 12: User Story 9 - è‡ªåŠ¨åŒ–æ‹¼æ¥è´¨é‡è¯„åˆ† (Priority: P4)

**Goal**: åœ¨ Rust å„æ‹¼æ¥æ¨¡å—æ·»åŠ  `#[cfg(test)]` è´¨é‡è¯„åˆ†æµ‹è¯•ï¼Œå¹¶æä¾› Python æ‰¹é‡è¯„ä¼°è„šæœ¬ï¼Œè¾“å‡ºå¸¦é€šè¿‡/å¤±è´¥é˜ˆå€¼çš„ JSON è¯„åˆ†å¡ã€‚

**Independent Test**: `cargo test -p frame-forge stitch_quality` å…¨éƒ¨é€šè¿‡ï¼Œä¸” `uv run --with opencv-python,scikit-image python tests/stitch-eval/score.py tests/stitch-eval/fixtures/` è¾“å‡º JSON è¯„åˆ†å¡ä¸”æ‰€æœ‰æŒ‡æ ‡çŠ¶æ€ä¸º passã€‚

### æµ‹è¯•åŸºç¡€è®¾æ–½

- [ ] T092 [P] [US9] åˆ›å»º `tests/stitch-eval/thresholds.json`ï¼Œå†…å®¹ï¼š`{ "ssim_min": 0.80, "seam_grad_max": 25.0, "color_de_max": 10.0, "ransac_inlier_min": 0.40, "rmse_max": 5.0 }`ï¼ŒRust æµ‹è¯•å’Œ Python è„šæœ¬å‡ä»æ­¤æ–‡ä»¶è¯»å–é˜ˆå€¼
- [ ] T093 [P] [US9] åˆ›å»º `tests/stitch-eval/gen_synthetic.sh`ï¼šç”¨ FFmpeg `crop` æ»¤é•œæŠŠå•å¼ å‚è€ƒå›¾è£åˆ‡å‡º 4 ä¸ªæ°´å¹³åç§»å­å›¾ï¼ˆæ¯æ¬¡åç§» N pxï¼Œé»˜è®¤ N=100ï¼‰ï¼Œç”¨äºåœºæ™¯ A Phase Correlation è·¯å¾„éªŒè¯ï¼›è„šæœ¬è¾“å‡ºåˆ° `tests/stitch-eval/fixtures/scene_a/`
- [ ] T094 [P] [US9] åœ¨ `src/frame-forge/Cargo.toml` `[dev-dependencies]` æ·»åŠ ï¼š`serde_json = "1"` (è¯»å– thresholds.json)ï¼›`image` å·²æ˜¯ç”Ÿäº§ä¾èµ–ï¼Œæ— éœ€é‡å¤æ·»åŠ 

### Rust æ‹¼æ¥è´¨é‡æµ‹è¯•æ¨¡å—

- [ ] T095 [P] [US9] åœ¨ `src/frame-forge/src/stitch_anime.rs` æ·»åŠ  `#[cfg(test)] mod quality_tests`ï¼šå®ç° `ssim(img_a, img_b) -> f32`ï¼ˆåŸºäºåƒç´ å‡å€¼/æ–¹å·®/åæ–¹å·®ï¼‰ã€`seam_grad_jump(stitched, seam_x) -> f32`ï¼ˆæ¥ç¼å·¦å³å„ 5px æ¢¯åº¦å‡å€¼å·®ï¼‰ã€`color_de_mean(img_a, img_b) -> f32`ï¼ˆL*a*b* æ¬§æ°è·ç¦»å‡å€¼ï¼‰ï¼›å¯¹ gen_synthetic.sh ç”Ÿæˆçš„åˆæˆå¹³ç§»åºåˆ—éªŒè¯ SSIM â‰¥ 0.90
- [ ] T096 [P] [US9] åœ¨ `src/frame-forge/src/stitch_landscape.rs` æ·»åŠ  `#[cfg(test)] mod quality_tests`ï¼šå¤ç”¨ T095 çš„ ssim/seam_grad/color_de å‡½æ•°ï¼›é¢å¤–å®ç° `ransac_inlier_rate(matches, inliers) -> f32` å’Œ `reprojection_rmse(pts_src, pts_dst, h) -> f32`ï¼›å¯¹ SEAGULL fixturesï¼ˆè‹¥å­˜åœ¨ï¼‰éªŒè¯ SSIM â‰¥ 0.80ã€RANSAC å†…ç‚¹ç‡ â‰¥ 0.40
- [ ] T097 [P] [US9] åœ¨ `src/frame-forge/src/stitch_liveaction.rs` æ·»åŠ  `#[cfg(test)] mod quality_tests`ï¼šå¤ç”¨ä¸Šè¿°æŒ‡æ ‡å‡½æ•°ï¼›å¯¹ Walking Tour fixturesï¼ˆè‹¥å­˜åœ¨ï¼‰éªŒè¯ SSIM â‰¥ 0.80ã€RMSE â‰¤ 5.0pxï¼›æµ‹è¯•æ•°æ®é›†ä¸å­˜åœ¨æ—¶ç”¨ `#[ignore]` æ ‡è®°è¯¥æµ‹è¯•ï¼ˆä¸é˜»å¡ CIï¼‰

### Python æ‰¹é‡è¯„ä¼°è„šæœ¬

- [ ] T098 [US9] åˆ›å»º `tests/stitch-eval/score.py`ï¼šæ¥æ”¶å‚æ•° `<fixtures_dir>`ï¼Œéå†å­ç›®å½•ä¸­çš„ `(input_a.png, input_b.png, reference.png)` ä¸‰å…ƒç»„ï¼›å¯¹æ¯å¯¹è®¡ç®— SSIMã€Î”Eã€RMSEã€æ¥ç¼æ¢¯åº¦è·³å˜ï¼ˆå¯é€‰ RANSAC å†…ç‚¹ç‡ï¼‰ï¼›è¾“å‡º JSON åˆ° stdoutï¼š`{ "pairs": [{...per-pair metrics...}], "summary": { "ssim_mean": x, ..., "overall": "pass"|"fail" } }`
- [ ] T099 [US9] `score.py` ä» `thresholds.json` è¯»å–é˜ˆå€¼ï¼ˆä¸ Rust æµ‹è¯•å…±äº«åŒä¸€é…ç½®æ–‡ä»¶ï¼‰ï¼Œä»»ä¸€æŒ‡æ ‡ä½äºé˜ˆå€¼æ—¶åœ¨ stderr æ‰“å° `FAIL: ssim=0.72 < 0.80` æ ¼å¼ï¼Œé€€å‡ºç ä¸º 1ï¼›fixtures ç›®å½•ä¸å­˜åœ¨æ—¶é€€å‡ºç ä¸º 2 å¹¶æ‰“å°æç¤º
- [ ] T100 [P] [US9] åˆ›å»º `tests/stitch-eval/README.md`ï¼ˆæˆ–åœ¨ research.md æ·»åŠ ç« èŠ‚ï¼‰ï¼šè®°å½•å¦‚ä½•ç”¨ `gen_synthetic.sh` ç”Ÿæˆåœºæ™¯ A fixturesï¼Œå¦‚ä½•ä¸‹è½½ SEAGULL/UDIS-D æ•°æ®é›†å›¾åƒå¯¹ï¼Œå¦‚ä½•è¿è¡Œ `score.py`

**Checkpoint**: `cargo test -p frame-forge` é€šè¿‡ï¼ˆåŒ…å« quality_testsï¼Œæ•°æ®é›†ä¸å­˜åœ¨çš„ç”¨ä¾‹ `#[ignore]`ï¼‰ï¼›`python tests/stitch-eval/score.py tests/stitch-eval/fixtures/` åœ¨åˆæˆ fixtures ä¸Šè¾“å‡º overall=pass

## Phase 13: Arc A310 GPU é€ä¼ ä¸ OpenCL è·¯å¾„éªŒè¯ (Priority: P4)

**Goal**: å°†å®¿ä¸»æœº Intel Arc A310 æ˜¾å¡é€ä¼ è¿› Docker å®¹å™¨ï¼Œå®‰è£… `intel-opencl-icd`ï¼Œå¹¶åœ¨ frame-forge æµ‹è¯•ä¸­éªŒè¯ GPU åŠ é€Ÿè·¯å¾„ï¼ˆWarp/Blendingï¼‰ä¸ CPU fallback ç»“æœä¸€è‡´ã€‚

**Independent Test**: å®¹å™¨å†… `clinfo | grep "Arc A310"` æœ‰è¾“å‡ºï¼›`cargo test -p frame-forge gpu_opencl` é€šè¿‡ï¼ˆå« OpenCL å¯ç”¨æ€§æ–­è¨€å’Œ GPU/CPU SSIM å¯¹æ¯”ï¼‰ã€‚

### ä¸€æ¬¡æ€§ä¸»æœºé…ç½®ï¼ˆæ‰‹åŠ¨æ­¥éª¤ï¼Œéè‡ªåŠ¨åŒ–ï¼‰

- [ ] T101 **[æ‰‹åŠ¨]** åœ¨ Windows å®¿ä¸»æœºå®‰è£… Intel Arc æ˜¾å¡é©±åŠ¨ï¼ˆâ‰¥ 31.0.101.4887ï¼Œä¸‹è½½è‡ª intel.com/arc-graphics-softwareï¼‰ï¼›å®‰è£…åé‡å¯ï¼Œåœ¨ WSL2 ç»ˆç«¯æ‰§è¡Œ `ls /dev/dri/`ï¼Œç¡®è®¤å‡ºç° `renderD128`ï¼ˆArc A310ï¼‰å’Œ `card0/card1`ï¼›è‹¥ä»æ— åˆ™ç¡®è®¤é©±åŠ¨å« WSL2 GPU æ”¯æŒ

### Docker è¿è¡Œå‘½ä»¤æ›´æ–°

- [ ] T102 æ›´æ–° `CLAUDE.md` å’Œ `memory/` ä¸­çš„ Docker å¯åŠ¨å‘½ä»¤ï¼Œæ·»åŠ  GPU é€ä¼ å‚æ•°ï¼š
  ```bash
  MSYS_NO_PATHCONV=1 docker run -d --name jellyfin-dev     -p 8600:8096     -v jellyfin-config:/config     -v jellyfin-cache:/cache     -v "d:/Dev/jellyfin-recents/demo:/media/demo"     -e JELLYFIN_WEB_DIR=/jellyfin/jellyfin-web     --device /dev/dri:/dev/dri     --group-add video     --group-add render     jellyfin/jellyfin:latest
  ```
  æ³¨æ„ï¼š`--group-add render` ç¡®ä¿å®¹å™¨è¿›ç¨‹å¯è®¿é—® `/dev/dri/renderD128`ï¼ˆArc è®¡ç®—èŠ‚ç‚¹ï¼‰

### å®¹å™¨å†… OpenCL è¿è¡Œæ—¶å®‰è£…

- [ ] T103 åœ¨ `Makefile` çš„ `build-frame-forge` Docker build æ­¥éª¤æ·»åŠ  OpenCL è¿è¡Œæ—¶å®‰è£…ï¼š
  ```makefile
  apt-get install -y intel-opencl-icd clinfo ocl-icd-libopencl1
  ```
  å¹¶åœ¨ build æ­¥éª¤æœ«å°¾æ‰§è¡Œ `clinfo --list` éªŒè¯å¹³å°å¯è§ï¼ˆè‹¥æ—  GPU åˆ™è¾“å‡º"no platforms"ä½†ä¸æŠ¥é”™ï¼Œä¿æŒ CPU fallback å¯ç”¨ï¼‰

- [ ] T104 [P] åœ¨ `.mise.toml` æ·»åŠ  `check-gpu` taskï¼š
  ```toml
  [tasks.check-gpu]
  run = "docker exec jellyfin-dev clinfo 2>&1 | grep -E 'Platform|Device|Arc'"
  description = "Verify Arc A310 OpenCL is visible inside jellyfin-dev container"
  ```

### Rust GPU è·¯å¾„æµ‹è¯•

- [ ] T105 [P] [US9] åœ¨ `src/frame-forge/src/main.rs` daemon å¯åŠ¨æ—¥å¿—ä¸­æ·»åŠ  OpenCL å¯ç”¨æ€§æ£€æµ‹å¹¶è¾“å‡ºï¼š
  ```rust
  let has_ocl = opencv::core::ocl::have_open_cl().unwrap_or(false);
  let platforms = opencv::core::ocl::Platform::list().unwrap_or_default();
  tracing::info!("OpenCL available={has_ocl}, platforms={}", platforms.len());
  ```
  è¿™æ ·ç”Ÿäº§æ—¥å¿—ä¸­å¯ç›´æ¥ç¡®è®¤ GPU æ˜¯å¦è¢«æ¿€æ´»

- [ ] T106 [P] [US9] åœ¨ `src/frame-forge/src/stitch_landscape.rs` `#[cfg(test)] mod quality_tests` æ·»åŠ  GPU è·¯å¾„å¯¹æ¯”æµ‹è¯•ï¼š
  - å½“ç¯å¢ƒå˜é‡ `FRAME_FORGE_TEST_GPU=1` å­˜åœ¨æ—¶æ‰§è¡Œï¼ˆå¦åˆ™ `#[ignore]`ï¼‰
  - ç”¨ç›¸åŒè¾“å…¥åˆ†åˆ«è·‘ CPU pathï¼ˆ`setUseOpenCL(false)`ï¼‰å’Œ GPU pathï¼ˆ`setUseOpenCL(true)`ï¼‰
  - æ–­è¨€ä¸¤è€… SSIM â‰¥ 0.80 ä¸”ä¸¤è·¯ç»“æœäº’ç›¸ SSIM â‰¥ 0.95ï¼ˆGPU ä¸åº”äº§ç”Ÿæ˜æ˜¾è´¨é‡å·®å¼‚ï¼‰
  - æ–­è¨€ GPU path è€—æ—¶ â‰¤ CPU path Ã— 2.0ï¼ˆå…è®¸é¦–æ¬¡ JIT ç¼–è¯‘å¼€é”€ï¼Œä¸è¦æ±‚ä¸¥æ ¼åŠ é€Ÿï¼‰

- [ ] T107 [P] [US9] åœ¨ `src/frame-forge/src/main.rs` `#[cfg(test)]` æ·»åŠ  `test_opencl_detected`ï¼š
  ```rust
  #[test]
  #[cfg_attr(not(env = "FRAME_FORGE_TEST_GPU"), ignore)]
  fn test_opencl_detected() {
      assert!(opencv::core::ocl::have_open_cl().unwrap_or(false),
              "Arc A310 OpenCL not detected â€” check /dev/dri passthrough and intel-opencl-icd");
  }
  ```

**Checkpoint**: `FRAME_FORGE_TEST_GPU=1 cargo test -p frame-forge gpu opencl` åœ¨é…ç½®äº† GPU çš„å®¹å™¨ä¸­å…¨éƒ¨é€šè¿‡ï¼›æ—  GPU ç¯å¢ƒä¸‹æ‰€æœ‰ `#[ignore]` æµ‹è¯•è¢«è·³è¿‡ï¼ŒCI ä¸æŠ¥é”™

---

---

## Dependencies & Execution Order

### Phase Dependencies

```
Phase 1 (T001¨CT010): Setup ¡ª ÎŞÒÀÀµ
  ¡ı
Phase 2 (T011¨CT022): Foundational ¡ª ÒÀÀµ Phase 1 Íê³É
  ¡ı
Phase 3 (T023¨CT029): US1 Ö¡Ñ¡ÔñÆ÷ ¡ª ÒÀÀµ Phase 2
  ¡ı
Phase 4 (T030¨CT033): US2 À©Õ¹»ñÈ¡ ¡ª ÒÀÀµ Phase 3 (Íø¸ñÒ³ÒÑ´æÔÚ)
  ¡ı
Phase 5 (T034¨CT037): US3 Ö¡Ñ¡Ôñ ¡ª ÒÀÀµ Phase 3
  ¡ı
Phase 6 (T038¨CT049): US4 ¶¯»­µ¼³ö ¡ª ÒÀÀµ Phase 2 (Rust daemon + C# Í¨ĞÅ²ã)
  ¡ı
Phase 7 (T050¨CT055): US7 SSE+³É¹û¹ÜÀí ¡ª ÒÀÀµ Phase 6 (C# ÈÎÎñ¹ÜÀíÒÑ´æÔÚ)
  ¡ı
Phase 8 (T056¨CT060): US6 ²ÎÊıÅäÖÃ ¡ª ÒÀÀµ Phase 3 (¹¤¾ßÀ¸ÒÑ´æÔÚ)
  ¡ı
Phase 9 (T061¨CT064): US8 ¶àÒ³ÃæÄ£Ì¬ ¡ª ÒÀÀµ Phase 3+5+7 (ÈıÒ³¾ùÒÑ´æÔÚ)
  ¡ı
Phase 10 (T065¨CT082): US5 È«¾°Æ´½Ó ¡ª ÒÀÀµ Phase 2+7 (Rust daemon + SSE ¿ò¼Ü)
  ¡ı
Phase 11 (T083¨CT091c): Polish ¡ª ÒÀÀµËùÓĞ story
  â†“
Phase 12 (T092â€“T100): US9 è‡ªåŠ¨åŒ–è¯„åˆ† â€” éœ€è¦ Phase 10 (US5 æ‹¼æ¥æ¨¡å—å·²å®ç°)
```

### User Story Dependencies

| Story | ¿É¿ªÊ¼Ê±»ú | ÒÀÀµ¹ÊÊÂ |
|-------|----------|---------|
| US1 (P1) | Phase 2 Íê³Éºó | ÎŞ |
| US2 (P1) | US1 Íê³Éºó | US1 (Íø¸ñÒ³) |
| US3 (P1) | US1 Íê³Éºó | US1 (Íø¸ñÒ³) |
| US4 (P2) | Phase 2 Íê³Éºó | ÎŞ£¨´¿ºó¶Ë+C#£¬¿É²¢ĞĞ US1-3£© |
| US6 (P2) | US1 Íê³Éºó | US1 (¹¤¾ßÀ¸) |
| US7 (P2) | US4 Íê³Éºó | US4 (C# ÈÎÎñ¹ÜÀí+¶Ëµã) |
| US5 (P3) | US4+US7 Íê³Éºó | US4, US7 (SSE ¿ò¼Ü) |
| US8 (P3) | US1+US3+US7 Íê³Éºó | US1, US3, US7 (ÈıÒ³Ãæ) |
| US9 (P4) | Phase 10 (US5) åŒæ—¶å¯å¼€å§‹ | US5 (æ‹¼æ¥æ¨¡å—å·²å®ç°å¯ä¾›æµ‹è¯•) |

### Parallel Opportunities

```
Phase 1 ÄÚ²¿: T003¡¬T004¡¬T005¡¬T006¡¬T008¡¬T009 (È«²¿²»Í¬ÎÄ¼ş)
Phase 2 ÄÚ²¿: T011b¡¬T012¡¬T013¡¬T014¡¬T016 (Rust ¸÷Ä£¿é¶ÀÁ¢£¬T011b »º´æ½á¹¹Óë T011 socket ¿É²¢ĞĞ)
              T022 (Ç°¶Ë) ¿ÉÓë Rust ²¢ĞĞ
Phase 3+4+5 ¿ÉÓë Phase 6 ²¢ĞĞ£¨Ç°¶ËÍø¸ñ vs ºó¶Ë¶¯»­±àÂë£©
Phase 10 ÄÚ²¿: T065¡¬T066¡¬T067¡¬T069¡¬T071¡¬T072¡¬T074¡¬T075¡¬T078 (Rust ¸÷Ëã·¨Ä£¿é¶ÀÁ¢)
```

---

## Parallel Example: Phase 10 (Rust È«¾°Æ´½Ó)

```bash
# ËùÓĞ³¡¾°Ëã·¨Ä£¿é¿É²¢ĞĞ¿ª·¢£¨²»Í¬ÎÄ¼ş£©£º
Task: "T065 [P] [US5] ³¡¾°·ÖÀàÆ÷ src/frame-forge/src/scene_classifier.rs"
Task: "T066 [P] [US5] ¾µÍ·ÔË¶¯Ô¤¼ì src/frame-forge/src/scene_classifier.rs"
Task: "T067 [P] [US5] Phase Correlation Æ´½Ó src/frame-forge/src/stitch_anime.rs"
Task: "T069 [P] [US5] ¸ßÎÆÀí ROI ÑÚÂë src/frame-forge/src/stitch_landscape.rs"
Task: "T071 [P] [US5] ÖùÃæÍ¶Ó° src/frame-forge/src/stitch_landscape.rs"
Task: "T072 [P] [US5] Ö¡²îÔË¶¯ÑÚÂë src/frame-forge/src/stitch_liveaction.rs"
Task: "T074 [P] [US5] Ç°¾°Ìî³ä src/frame-forge/src/stitch_liveaction.rs"
Task: "T075 [P] [US5] ÔöÒæ²¹³¥ src/frame-forge/src/blender.rs"
Task: "T078 [P] [US5] pHash ½üÖØ¸´Ö¡ src/frame-forge/src/main.rs"
```

---

## Implementation Strategy

### MVP First (User Stories 1-3: Frame Selector)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (CRITICAL)
3. Complete Phase 3: US1 (Modal + Grid)
4. Complete Phase 4: US2 (Expand)
5. Complete Phase 5: US3 (Selection)
6. **STOP and VALIDATE**: Frame selector works end-to-end
7. Deploy/demo: Users can browse video keyframes in a modal

### Incremental Delivery

1. Setup + Foundational ¡ú Base infra ready
2. US1¨C3 ¡ú Frame Selector Grid (MVP! Browse & select frames)
3. US4 + US7 + US6 ¡ú Animation Export (Generate GIF/WebP with SSE progress)
4. US8 ¡ú Multi-page Modal Navigation (Polish UX)
5. US5 ¡ú Panorama Stitching (Advanced feature)
6. Each increment adds value without breaking prior

### Suggested MVP Scope

**Minimum**: US1 (Open frame selector) ¡ª user can see 11 keyframe thumbnails in a modal.
**Recommended MVP**: US1 + US2 + US3 ¡ª user can browse, expand, select frames. At this point users get value (visual preview of video frames) even without export.
**Full MVP**: + US4 + US7 + US6 ¡ª user can select frames and export as animated GIF/WebP.
7. US9 è‡ªåŠ¨åŒ–æ‹¼æ¥è´¨é‡è¯„åˆ† â†’ Rust `#[cfg(test)]` + Python è¯„åˆ†è„šæœ¬ï¼Œå¯åœ¨ US5 åä»»ä½•æ—¶é—´ç‹¬ç«‹æŒ‡è¡Œ

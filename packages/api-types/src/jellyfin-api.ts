export interface paths {
    "/JellyfinSuite/PlayHistory": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get */
        get: operations["playHistory_get"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/{itemId}/FrameInfo": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Frame Info */
        get: operations["jellyfinSuite_getFrameInfo"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/{itemId}/FrameInfoStream": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Frame Info Stream */
        get: operations["jellyfinSuite_frameInfoStream"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/SeekPreview/{itemId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Frame */
        get: operations["seekPreview_getFrame"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/SeekPreview/{itemId}/frame-info": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Frame Info */
        get: operations["seekPreview_getFrameInfo"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/SeekPreview/{itemId}/frame-index": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Frame Index */
        get: operations["seekPreview_getFrameIndex"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/SeekPreview/{itemId}/ready-stream": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Ready Stream */
        get: operations["seekPreview_readyStream"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/FrameExport/{itemId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Frame */
        get: operations["frameExport_getFrame"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/FrameExport/Prefetch/{itemId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Prefetch */
        post: operations["frameExport_prefetch"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/FrameExport/PrefetchReady/{itemId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Prefetch Ready */
        post: operations["frameExport_prefetchReady"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/FrameExport/Generate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Generate */
        post: operations["frameExport_generate"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/FrameExport/TaskProgress": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Task Progress */
        get: operations["frameExport_taskProgress"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/FrameExport/Result/{taskId}/{filename}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Result */
        get: operations["frameExport_getResult"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/FrameExport/Result/{taskId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Delete Result */
        delete: operations["frameExport_deleteResult"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/FrameExport/Cancel/{taskId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Cancel */
        post: operations["frameExport_cancel"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/FrameExport/Tasks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Tasks */
        get: operations["frameExport_getTasks"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/FrameExport/Health": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Health */
        get: operations["frameExport_health"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/FrameExport/Debug": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Debug */
        get: operations["frameExport_debug"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/FrameExport/QualityThresholds": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Quality Thresholds */
        get: operations["frameExport_getQualityThresholds"];
        /** Set Quality Thresholds */
        put: operations["frameExport_setQualityThresholds"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/PosterSheet/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Start Job */
        post: operations["posterSheet_startJob"];
        /** Delete Job */
        delete: operations["posterSheet_deleteJob"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/PosterSheet/jobs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Jobs */
        get: operations["posterSheet_listJobs"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/PosterSheet/{jobId}/status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Status */
        get: operations["posterSheet_getStatus"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/PosterSheet/{jobId}/image": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Image */
        get: operations["posterSheet_getImage"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/PosterSheet/{jobId}/stream": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Stream Status */
        get: operations["posterSheet_streamStatus"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/PosterSheet/preview": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Preview */
        post: operations["posterSheet_preview"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/PosterSheet/cache/{itemId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Check Cache */
        get: operations["posterSheet_checkCache"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/PosterSheet/fonts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** List Fonts */
        get: operations["posterSheet_listFonts"];
        put?: never;
        /** Upload Font */
        post: operations["posterSheet_uploadFont"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/PosterSheet/fonts/{key}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Delete Font */
        delete: operations["posterSheet_deleteFont"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/Stitch/Devices": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Devices */
        get: operations["stitch_getDevices"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/Stitch/Models": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Models */
        get: operations["stitch_getModels"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/Stitch/Models/Download": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Download Model */
        post: operations["stitch_downloadModel"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/Stitch/Models/DownloadProgress": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Model Download Progress */
        get: operations["stitch_getModelDownloadProgress"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/Stitch/Models/{family}/{version}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Delete Model */
        delete: operations["stitch_deleteModel"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/Stitch/OrtVersions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Ort Versions */
        get: operations["stitch_getOrtVersions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/Stitch/OrtVersions/Download": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Download Ort Version */
        post: operations["stitch_downloadOrtVersion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/Stitch/OrtVersions/Activate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Activate Ort Version */
        post: operations["stitch_activateOrtVersion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/Stitch/OrtVersions/DownloadProgress": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Ort Download Progress */
        get: operations["stitch_getOrtDownloadProgress"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/Stitch/Upscale": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Start Upscale */
        post: operations["stitch_startUpscale"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/Stitch/Upscale/{jobId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Upscale Status */
        get: operations["stitch_getUpscaleStatus"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/Stitch/Upscale/{jobId}/Result": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Upscale Result */
        get: operations["stitch_getUpscaleResult"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/Stitch/Upscale/{jobId}/Log": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Get Upscale Log */
        get: operations["stitch_getUpscaleLog"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/Stitch/Upscale/{jobId}/Cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Cancel Upscale */
        post: operations["stitch_cancelUpscale"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        PrefetchRangeStreamRequest: {
            /** Format: int64 */
            currentTimeMs?: number | null;
            /** Format: int64 */
            currentFrameIndex?: number | null;
            /** Format: double */
            beforeSeconds?: number | null;
            /** Format: double */
            afterSeconds?: number | null;
            includeCurrentFrame: boolean;
            /** Format: int32 */
            width: number;
            prefetchSessionId: string;
        };
        PrefetchRequest: {
            /** Format: int32 */
            startFrameIdx: number;
            /** Format: double */
            beforeSeconds: number;
            /** Format: double */
            afterSeconds: number;
            includeStart: boolean;
            /** Format: int32 */
            width: number;
            positions?: number[] | null;
            framePairs?: components["schemas"]["FramePairDto"][] | null;
        };
        FramePairDto: {
            /** Format: int64 */
            fiIdx: number;
            /** Format: int64 */
            posMs: number;
        };
        GenerateRequest: {
            /** Format: uuid */
            itemId: string;
            itemTitle: string;
            type: string;
            frames: components["schemas"]["FrameReference"][];
            params: components["schemas"]["ExportParams"];
        };
        FrameReference: {
            /** Format: int32 */
            frameIdx?: number | null;
            /** Format: int64 */
            positionMs?: number | null;
        };
        ExportParams: {
            format: string;
            resizeMode: string;
            /** Format: int32 */
            customWidth?: number | null;
            /** Format: int32 */
            customHeight?: number | null;
            resolutionPreset: string;
            /** Format: float */
            speed: number;
            /** Format: int32 */
            loopCount: number;
            /** Format: float */
            cropX?: number | null;
            /** Format: float */
            cropY?: number | null;
            /** Format: float */
            cropW?: number | null;
            /** Format: float */
            cropH?: number | null;
            /** Format: float */
            quality: number;
            deviceId?: string | null;
            modelFamily?: string | null;
            modelVersion?: string | null;
            ortVersion?: string | null;
        };
        GenerateResponse: {
            taskId: string;
        };
        TaskProgressDto: {
            taskId: string;
            status: string;
            phase: string;
            /** Format: int32 */
            current: number;
            /** Format: int32 */
            total: number;
            /** Format: double */
            percent: number;
            resultUrl?: string | null;
            /** Format: int64 */
            fileSize?: number | null;
            error?: string | null;
        };
        QualityThresholds: {
            /** Format: double */
            blackBrightnessVarMin: number;
            /** Format: double */
            whiteBrightnessVarMax: number;
            /** Format: double */
            blurLaplacianVarMin: number;
        };
        FrameExportTaskListItemDto: {
            taskId: string;
            itemId: string;
            itemTitle: string;
            type: string;
            status: string;
            resultUrl?: string | null;
            /** Format: int64 */
            fileSize?: number | null;
            error?: string | null;
            /** Format: int64 */
            createdAt: number;
            upscaled: boolean;
        };
        FrameInfoDto: {
            /** Format: int64 */
            frameIdx: number;
            /** Format: int64 */
            frameStartMs: number;
        };
        FrameIndexDto: {
            frames: components["schemas"]["FrameIndexEntryDto"][];
            fps: components["schemas"]["FpsFracDto"];
        };
        FrameIndexEntryDto: {
            /** Format: int64 */
            frameIndex: number;
            /** Format: int64 */
            ms: number;
            isKey: boolean;
        };
        FpsFracDto: {
            /** Format: int64 */
            num: number;
            /** Format: int64 */
            den: number;
        };
        PosterSheetStatusDto: {
            jobId: string;
            itemId: string;
            itemTitle: string;
            status: string;
            /** Format: int32 */
            progress: number;
            /** Format: int32 */
            total: number;
            error?: string | null;
            mediaInfo?: components["schemas"]["MediaInfoDto"] | null;
            /** Format: int64 */
            createdAt: number;
        };
        StartJobResponseDto: {
            jobId: string;
        };
        CacheCheckResponseDto: {
            cached: boolean;
            jobId?: string | null;
        };
        SkipSegmentDto: {
            /** Format: int64 */
            startMs: number;
            /** Format: int64 */
            endMs: number;
        };
        PosterSheetRequestDto: {
            /** Format: int32 */
            rows: number;
            /** Format: int32 */
            cols: number;
            mode: string;
            seed?: string | null;
            /** Format: int32 */
            thumbWidth: number;
            overlay: components["schemas"]["OverlaySettings"];
            skipSegments?: components["schemas"]["SkipSegmentDto"][] | null;
        };
        PreviewRequestDto: {
            /** Format: int32 */
            rows: number;
            /** Format: int32 */
            cols: number;
            /** Format: int32 */
            thumbWidth: number;
            overlay: components["schemas"]["OverlaySettings"];
        };
        OverlaySettings: {
            brandingEnabled: boolean;
            brandingText: string;
            videoInfoEnabled: boolean;
            showFileSize: boolean;
            showResolutionFps: boolean;
            showVideoEncoding: boolean;
            showAudioEncoding: boolean;
            showDuration: boolean;
            showSubtitles: boolean;
            showFrameTimestamp: boolean;
            timestampFont: string;
            timestampBg: boolean;
            timestampShadow: boolean;
            colorTheme: string;
            fontFamily: string;
            brandingLatinFont: string;
            brandingCjkFont: string;
            lang: string;
            timestampPosition: string;
        };
        MediaInfoDto: {
            filename: string;
            fileSize: string;
            /** Format: int64 */
            fileSizeBytes: number;
            resolution: string;
            /** Format: double */
            fps: number;
            videoCodec: string;
            /** Format: int32 */
            bitDepth?: number | null;
            hdrType?: string | null;
            colourSpace?: string | null;
            audioCodec?: string | null;
            audioFormat?: string | null;
            audioBitrate?: string | null;
            /** Format: int32 */
            audioSampleRate?: number | null;
            /** Format: int32 */
            audioTracks: number;
            /** Format: int32 */
            subtitleCount: number;
            duration: string;
        };
        PlayHistoryEntry: {
            itemId: string;
            /** Format: date-time */
            playedDate: string;
            title?: string | null;
            mediaType: string;
            /** Format: date-time */
            favoritedAt?: string | null;
            /** Format: date-time */
            releaseDate?: string | null;
            /** Format: date-time */
            addedDate?: string | null;
            seriesName?: string | null;
            seriesId?: string | null;
            /** Format: int32 */
            seasonNumber?: number | null;
            /** Format: int32 */
            episodeNumber?: number | null;
            imagePrimaryTag?: string | null;
            hasAncestors: boolean;
            /** Format: int64 */
            playbackPositionTicks?: number | null;
            /** Format: double */
            videoDuration?: number | null;
        };
        PlayHistoryResponse: {
            entries: components["schemas"]["PlayHistoryEntry"][];
            /** Format: int32 */
            totalCount: number;
            /** Format: int32 */
            totalPages: number;
        };
        ComputeDeviceDto: {
            id: string;
            displayName: string;
            deviceType: string;
            vendor: string;
            /** Format: int64 */
            vramMb?: number | null;
            isIntegrated: boolean;
            isDefault: boolean;
            computeCapability?: string | null;
            modelName?: string | null;
            devicePath?: string | null;
        };
        DeviceListDto: {
            devices: components["schemas"]["ComputeDeviceDto"][];
        };
        ModelEntryDto: {
            family: string;
            displayName: string;
            version: string;
            fileName: string;
            /** Format: int64 */
            fileSizeBytes?: number | null;
            sha256?: string | null;
            downloadUrl?: string | null;
            releaseDate?: string | null;
            status: string;
            localPath?: string | null;
            lastUsedAt?: string | null;
            isLatest: boolean;
        };
        ModelListDto: {
            models: components["schemas"]["ModelEntryDto"][];
            catalogFetchedAt?: string | null;
            catalogStale: boolean;
        };
        ModelDownloadRequestDto: {
            family: string;
            version: string;
        };
        ModelDownloadProgressDto: {
            family: string;
            version: string;
            /** Format: double */
            percent: number;
            status: string;
            error?: string | null;
        };
        OrtAssetDto: {
            url: string;
            sha256: string;
            /** Format: int64 */
            sizeBytes: number;
        };
        OrtVersionDto: {
            version: string;
            releaseDate?: string | null;
            isActive: boolean;
            localDir?: string | null;
            installedAt?: string | null;
            assets?: {
                [key: string]: components["schemas"]["OrtAssetDto"];
            } | null;
            status: string;
        };
        OrtVersionListDto: {
            activeVersion?: string | null;
            versions: components["schemas"]["OrtVersionDto"][];
            /** Format: int32 */
            maxRetainedVersions: number;
        };
        OrtDownloadRequestDto: {
            version: string;
        };
        OrtActivateRequestDto: {
            version: string;
        };
        OrtDownloadProgressDto: {
            version: string;
            /** Format: double */
            percent: number;
            status: string;
            error?: string | null;
        };
        FallbackEventDto: {
            type: string;
            reason: string;
            timestamp: string;
        };
        UpscaleLogDto: {
            deviceName: string;
            deviceType: string;
            deviceId: string;
            faceRestoreRequested: boolean;
            faceRestoreSkippedNoFace: boolean;
            fallbacks: components["schemas"]["FallbackEventDto"][];
        };
        UpscaleStartRequestDto: {
            resultPath: string;
            /** Format: int32 */
            scale: number;
            /** Format: int32 */
            modelScale: number;
            modelStyle: string;
            faceRestore: boolean;
            deviceId?: string | null;
        };
        UpscaleJobDto: {
            jobId: string;
            status: string;
            /** Format: double */
            percent: number;
            error?: string | null;
            originalUrl?: string | null;
            resultUrl?: string | null;
            resultMimeType?: string | null;
            /** Format: int32 */
            originalWidth?: number | null;
            /** Format: int32 */
            originalHeight?: number | null;
            /** Format: int32 */
            resultWidth?: number | null;
            /** Format: int32 */
            resultHeight?: number | null;
            /** Format: int64 */
            originalSizeBytes?: number | null;
            /** Format: int64 */
            resultSizeBytes?: number | null;
            faceRestoreSkippedNoFace: boolean;
        };
        UpscaleJobLogDto: {
            jobId: string;
            status: string;
            error?: string | null;
            /** Format: int32 */
            scale: number;
            modelStyle: string;
            faceRestoreRequested: boolean;
            deviceIdRequested?: string | null;
            /** Format: date-time */
            createdAt: string;
            log?: components["schemas"]["UpscaleLogDto"] | null;
        };
        FontMetaRecord: {
            key: string;
            displayName: string;
            script: string;
            format: string;
            isSerif?: boolean | null;
            isMonospace?: boolean | null;
            isBold?: boolean | null;
            isItalic?: boolean | null;
            hasLigatures?: boolean | null;
        };
        FrameExportHealth: {
            available: boolean;
            /** Format: int32 */
            activeTasks: number;
        };
        SeekReadyEvent: {
            /** Format: int64 */
            frameReady: number;
        };
        FrameIndexStreamEvent: components["schemas"]["FrameIndexEntryDto"][] | {
            fps: components["schemas"]["FpsFracDto"];
        };
        PrefetchRangeEvent: {
            /** Format: int64 */
            frameReady: number;
        } | {
            done: boolean;
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    playHistory_get: {
        parameters: {
            query?: {
                groupBy?: string;
                page?: number;
                tz?: string;
                sortBy?: string;
                sortOrder?: string;
                mediaType?: string;
                showRepeats?: boolean;
                groupDedup?: boolean;
                pageSize?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Play history */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PlayHistoryResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    jellyfinSuite_getFrameInfo: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Frame index */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FrameIndexDto"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Service Unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    jellyfinSuite_frameInfoStream: {
        parameters: {
            query?: {
                currentTimeMs?: number;
            };
            header?: never;
            path: {
                itemId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Server-Sent Events stream */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/event-stream": components["schemas"]["FrameIndexStreamEvent"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Service Unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    seekPreview_getFrame: {
        parameters: {
            query?: {
                positionMs?: number;
                prefetch?: boolean;
                width?: number;
            };
            header?: never;
            path: {
                itemId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description JPEG frame */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "image/jpeg": string;
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Service Unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    seekPreview_getFrameInfo: {
        parameters: {
            query?: {
                positionMs?: number;
            };
            header?: never;
            path: {
                itemId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Frame info */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FrameInfoDto"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Service Unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    seekPreview_getFrameIndex: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Frame index */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FrameIndexDto"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Service Unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    seekPreview_readyStream: {
        parameters: {
            query?: {
                positionMs?: number;
            };
            header?: never;
            path: {
                itemId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Server-Sent Events stream */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/event-stream": components["schemas"]["SeekReadyEvent"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Service Unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    frameExport_getFrame: {
        parameters: {
            query?: {
                frameIdx?: number;
                positionMs?: number;
                width?: number;
            };
            header?: never;
            path: {
                itemId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description WebP frame */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "image/webp": string;
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Service Unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    frameExport_prefetch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PrefetchRequest"];
            };
        };
        responses: {
            /** @description Accepted */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Service Unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    frameExport_prefetchReady: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PrefetchRangeStreamRequest"];
            };
        };
        responses: {
            /** @description Server-Sent Events stream */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/event-stream": components["schemas"]["PrefetchRangeEvent"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Service Unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    frameExport_generate: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["GenerateRequest"];
            };
        };
        responses: {
            /** @description Task accepted */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GenerateResponse"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    frameExport_taskProgress: {
        parameters: {
            query: {
                taskId: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Server-Sent Events stream */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/event-stream": components["schemas"]["TaskProgressDto"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    frameExport_getResult: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                taskId: string;
                filename: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Result file */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": string;
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    frameExport_deleteResult: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                taskId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Deleted */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    frameExport_cancel: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                taskId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Cancelled */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Already complete */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    frameExport_getTasks: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Task list */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FrameExportTaskListItemDto"][];
                };
            };
        };
    };
    frameExport_health: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Health info */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FrameExportHealth"];
                };
            };
        };
    };
    frameExport_debug: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Debug JSON */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Service Unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    frameExport_getQualityThresholds: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Quality thresholds */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["QualityThresholds"];
                };
            };
        };
    };
    frameExport_setQualityThresholds: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["QualityThresholds"];
            };
        };
        responses: {
            /** @description Updated thresholds */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["QualityThresholds"];
                };
            };
        };
    };
    posterSheet_startJob: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PosterSheetRequestDto"];
            };
        };
        responses: {
            /** @description Job started */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StartJobResponseDto"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unprocessable Entity */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    posterSheet_deleteJob: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description No Content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    posterSheet_listJobs: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Job list */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PosterSheetStatusDto"][];
                };
            };
        };
    };
    posterSheet_getStatus: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                jobId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Job status */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PosterSheetStatusDto"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    posterSheet_getImage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                jobId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Poster sheet image */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "image/webp": string;
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    posterSheet_streamStatus: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                jobId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Server-Sent Events stream */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/event-stream": components["schemas"]["PosterSheetStatusDto"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    posterSheet_preview: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PreviewRequestDto"];
            };
        };
        responses: {
            /** @description Preview image */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "image/webp": string;
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Service Unavailable */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    posterSheet_checkCache: {
        parameters: {
            query?: {
                rows?: number;
                cols?: number;
                thumbWidth?: number;
                seed?: string;
                overlayHash?: string;
            };
            header?: never;
            path: {
                itemId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Cache hit */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CacheCheckResponseDto"];
                };
            };
            /** @description Not cached */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    posterSheet_listFonts: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Font list */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FontMetaRecord"][];
                };
            };
        };
    };
    posterSheet_uploadFont: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "multipart/form-data": {
                    /** Format: binary */
                    file?: string;
                };
            };
        };
        responses: {
            /** @description Uploaded font */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FontMetaRecord"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    posterSheet_deleteFont: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                key: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description No Content */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    stitch_getDevices: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Compute device list */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DeviceListDto"];
                };
            };
        };
    };
    stitch_getModels: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Model catalog */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ModelListDto"];
                };
            };
        };
    };
    stitch_downloadModel: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ModelDownloadRequestDto"];
            };
        };
        responses: {
            /** @description Accepted */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Version not found in catalog */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Already installed or in progress */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    stitch_getModelDownloadProgress: {
        parameters: {
            query: {
                family: string;
                version: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Server-Sent Events stream */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/event-stream": components["schemas"]["ModelDownloadProgressDto"];
                };
            };
        };
    };
    stitch_deleteModel: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                family: string;
                version: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Deleted */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    stitch_getOrtVersions: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description ORT version list */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OrtVersionListDto"];
                };
            };
        };
    };
    stitch_downloadOrtVersion: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["OrtDownloadRequestDto"];
            };
        };
        responses: {
            /** @description Accepted */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Version not found in catalog */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    stitch_activateOrtVersion: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["OrtActivateRequestDto"];
            };
        };
        responses: {
            /** @description Activated */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Version not installed */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    stitch_getOrtDownloadProgress: {
        parameters: {
            query: {
                version: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Server-Sent Events stream */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "text/event-stream": components["schemas"]["OrtDownloadProgressDto"];
                };
            };
        };
    };
    stitch_startUpscale: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpscaleStartRequestDto"];
            };
        };
        responses: {
            /** @description Job accepted */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UpscaleJobDto"];
                };
            };
            /** @description Source result not found or expired */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    stitch_getUpscaleStatus: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                jobId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Job status */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UpscaleJobDto"];
                };
            };
            /** @description Job not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    stitch_getUpscaleResult: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                jobId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Upscaled image (not yet confirmed) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": string;
                };
            };
            /** @description Result not available */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    stitch_getUpscaleLog: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                jobId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Job diagnostics */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UpscaleJobLogDto"];
                };
            };
            /** @description Job not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    stitch_cancelUpscale: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                jobId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Cancelled */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Job not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
}

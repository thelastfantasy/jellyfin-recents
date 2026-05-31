export interface paths {
    "/JellyfinSuite/FrameExport/{itemId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["GetFrame"];
        put?: never;
        post?: never;
        delete?: never;
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
        post: operations["Cancel"];
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
        post: operations["Generate"];
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
        get: operations["Health"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/FrameExport/Keyframes/{itemId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["GetKeyframes"];
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
        post: operations["Prefetch"];
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
        get: operations["PrefetchReady"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/FrameExport/Progress": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["Progress"];
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
        get: operations["GetThresholds"];
        put: operations["SetThresholds"];
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
        delete: operations["DeleteResult"];
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
        get: operations["GetResult"];
        put?: never;
        post?: never;
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
        get: operations["GetTasks"];
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
        get: operations["GetFrameInfo"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/PlayerEnhancer/Config": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["GetConfig"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch: operations["SetConfig"];
        trace?: never;
    };
    "/JellyfinSuite/PlayerEnhancer/Core": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["GetCore"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/PlayerEnhancer/Inject": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["Inject"];
        delete: operations["Remove"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/PlayerEnhancer/Launcher": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["GetLauncher"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/PlayerEnhancer/Status": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["GetStatus"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/PlayHistory": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get: operations["GetPlayHistory"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/PosterSheet/{itemId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post: operations["StartJob"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/JellyfinSuite/PosterSheet/{jobId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete: operations["DeleteJob"];
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
        get: operations["GetImage"];
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
        get: operations["GetStatus2"];
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
        get: operations["StreamStatus"];
        put?: never;
        post?: never;
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
        get: operations["CheckCache"];
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
        get: operations["ListUserFonts"];
        put?: never;
        post: operations["UploadFont"];
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
        delete: operations["DeleteUserFont"];
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
        get: operations["ListJobs"];
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
        post: operations["Preview"];
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
        get: operations["GetFrame2"];
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
        get: operations["GetFrameIndex"];
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
        get: operations["GetFrameInfo2"];
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
        get: operations["ReadyStream"];
        put?: never;
        post?: never;
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
        CacheCheckResponseDto: {
            cached?: boolean;
            jobId?: string | null;
        };
        EnhancerStatusDto: {
            autoInjectEnabled?: boolean;
        };
        ExportParams: {
            format?: string;
            resizeMode?: string;
            /** Format: int32 */
            customWidth?: number | null;
            /** Format: int32 */
            customHeight?: number | null;
            resolutionPreset?: string;
            /** Format: float */
            speed?: number;
            /** Format: int32 */
            loopCount?: number;
            /** Format: float */
            cropX?: number | null;
            /** Format: float */
            cropY?: number | null;
            /** Format: float */
            cropW?: number | null;
            /** Format: float */
            cropH?: number | null;
            /** Format: float */
            quality?: number;
        };
        FpsFracDto: {
            /** Format: int64 */
            num?: number;
            /** Format: int64 */
            den?: number;
        };
        FrameIndexDto: {
            frames?: components["schemas"]["FrameIndexEntryDto"][];
            fps?: components["schemas"]["FpsFracDto"];
        };
        FrameIndexEntryDto: {
            /** Format: int64 */
            ms?: number;
            isKey?: boolean;
        };
        FrameInfoDto: {
            /** Format: int64 */
            frameIdx?: number;
            /** Format: int64 */
            frameStartMs?: number;
        };
        FrameReference: {
            /** Format: int32 */
            frameIdx?: number | null;
            /** Format: int64 */
            positionMs?: number | null;
        };
        GenerateRequest: {
            /** Format: uuid */
            itemId?: string;
            itemTitle?: string;
            type?: string;
            frames?: components["schemas"]["FrameReference"][];
            params?: components["schemas"]["ExportParams"];
        };
        GenerateResponse: {
            taskId?: string;
        };
        GestureConfigDto: {
            trickplayEnabled?: boolean;
            /** Format: double */
            seekSeconds?: number;
            /** Format: double */
            speedRate?: number;
        };
        MediaInfoDto: {
            filename?: string;
            fileSize?: string;
            /** Format: int64 */
            fileSizeBytes?: number;
            resolution?: string;
            /** Format: double */
            fps?: number;
            videoCodec?: string;
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
            audioTracks?: number;
            /** Format: int32 */
            subtitleCount?: number;
            duration?: string;
        };
        OverlaySettings: {
            brandingEnabled?: boolean;
            brandingText?: string;
            videoInfoEnabled?: boolean;
            showFileSize?: boolean;
            showResolutionFps?: boolean;
            showVideoEncoding?: boolean;
            showAudioEncoding?: boolean;
            showDuration?: boolean;
            showSubtitles?: boolean;
            showFrameTimestamp?: boolean;
            timestampFont?: string;
            timestampBg?: boolean;
            timestampShadow?: boolean;
            colorTheme?: string;
            fontFamily?: string;
            brandingLatinFont?: string;
            brandingCjkFont?: string;
            lang?: string;
            timestampPosition?: string;
        };
        PlayHistoryEntry: {
            itemId?: string;
            /** Format: date-time */
            playedDate?: string;
            title?: string | null;
            mediaType?: string;
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
            hasAncestors?: boolean;
            /** Format: int64 */
            playbackPositionTicks?: number | null;
            /** Format: double */
            videoDuration?: number | null;
        };
        PlayHistoryResponse: {
            entries?: components["schemas"]["PlayHistoryEntry"][];
            /** Format: int32 */
            totalCount?: number;
            /** Format: int32 */
            totalPages?: number;
        };
        PosterSheetRequestDto: {
            /** Format: int32 */
            rows?: number;
            /** Format: int32 */
            cols?: number;
            mode?: string;
            seed?: string | null;
            /** Format: int32 */
            thumbWidth?: number;
            overlay?: components["schemas"]["OverlaySettings"];
            skipSegments?: components["schemas"]["SkipSegmentDto"][] | null;
        };
        PosterSheetStatusDto: {
            jobId?: string;
            itemId?: string;
            itemTitle?: string;
            status?: string;
            /** Format: int32 */
            progress?: number;
            /** Format: int32 */
            total?: number;
            error?: string | null;
            mediaInfo?: components["schemas"]["MediaInfoDto"] | null;
            /** Format: int64 */
            createdAt?: number;
        };
        PrefetchRequest: {
            frameIndices?: number[];
            positions?: number[];
            /** Format: int32 */
            width?: number;
        };
        PreviewRequestDto: {
            /** Format: int32 */
            rows?: number;
            /** Format: int32 */
            cols?: number;
            /** Format: int32 */
            thumbWidth?: number;
            overlay?: components["schemas"]["OverlaySettings"];
        };
        ProblemDetails: {
            type?: string | null;
            title?: string | null;
            /** Format: int32 */
            status?: number | null;
            detail?: string | null;
            instance?: string | null;
        } & {
            [key: string]: unknown;
        };
        QualityThresholds: {
            /** Format: double */
            blackBrightnessVarMin?: number;
            /** Format: double */
            whiteBrightnessVarMax?: number;
            /** Format: double */
            blurLaplacianVarMin?: number;
        };
        SkipSegmentDto: {
            /** Format: int64 */
            startMs?: number;
            /** Format: int64 */
            endMs?: number;
        };
        StartJobResponseDto: {
            jobId?: string;
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
    GetFrame: {
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
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": string;
                    "application/json; profile=\"PascalCase\"": string;
                    "application/json; profile=\"CamelCase\"": string;
                    "text/plain": string;
                    "text/json": string;
                    "text/css": string;
                    "text/xml": string;
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"PascalCase\"": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"CamelCase\"": components["schemas"]["ProblemDetails"];
                    "text/plain": components["schemas"]["ProblemDetails"];
                    "text/json": components["schemas"]["ProblemDetails"];
                    "text/css": components["schemas"]["ProblemDetails"];
                    "text/xml": components["schemas"]["ProblemDetails"];
                };
            };
            /** @description Server Error */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    Cancel: {
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
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The server is currently starting or is temporarily not available. */
            503: {
                headers: {
                    /** @description A hint for when to retry the operation in full seconds. */
                    "Retry-After"?: number;
                    /** @description A short plain-text reason why the server is not available. */
                    Message?: string;
                    [name: string]: unknown;
                };
                content: {
                    "text/html": unknown;
                };
            };
        };
    };
    Generate: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["GenerateRequest"];
                "text/json": components["schemas"]["GenerateRequest"];
                "application/*+json": components["schemas"]["GenerateRequest"];
            };
        };
        responses: {
            /** @description Success */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GenerateResponse"];
                    "application/json; profile=\"PascalCase\"": components["schemas"]["GenerateResponse"];
                    "application/json; profile=\"CamelCase\"": components["schemas"]["GenerateResponse"];
                    "text/plain": components["schemas"]["GenerateResponse"];
                    "text/json": components["schemas"]["GenerateResponse"];
                    "text/css": components["schemas"]["GenerateResponse"];
                    "text/xml": components["schemas"]["GenerateResponse"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"PascalCase\"": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"CamelCase\"": components["schemas"]["ProblemDetails"];
                    "text/plain": components["schemas"]["ProblemDetails"];
                    "text/json": components["schemas"]["ProblemDetails"];
                    "text/css": components["schemas"]["ProblemDetails"];
                    "text/xml": components["schemas"]["ProblemDetails"];
                };
            };
            /** @description The server is currently starting or is temporarily not available. */
            503: {
                headers: {
                    /** @description A hint for when to retry the operation in full seconds. */
                    "Retry-After"?: number;
                    /** @description A short plain-text reason why the server is not available. */
                    Message?: string;
                    [name: string]: unknown;
                };
                content: {
                    "text/html": unknown;
                };
            };
        };
    };
    Health: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The server is currently starting or is temporarily not available. */
            503: {
                headers: {
                    /** @description A hint for when to retry the operation in full seconds. */
                    "Retry-After"?: number;
                    /** @description A short plain-text reason why the server is not available. */
                    Message?: string;
                    [name: string]: unknown;
                };
                content: {
                    "text/html": unknown;
                };
            };
        };
    };
    GetKeyframes: {
        parameters: {
            query?: {
                startMs?: number;
                endMs?: number;
            };
            header?: never;
            path: {
                itemId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The server is currently starting or is temporarily not available. */
            503: {
                headers: {
                    /** @description A hint for when to retry the operation in full seconds. */
                    "Retry-After"?: number;
                    /** @description A short plain-text reason why the server is not available. */
                    Message?: string;
                    [name: string]: unknown;
                };
                content: {
                    "text/html": unknown;
                };
            };
        };
    };
    Prefetch: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["PrefetchRequest"];
                "text/json": components["schemas"]["PrefetchRequest"];
                "application/*+json": components["schemas"]["PrefetchRequest"];
            };
        };
        responses: {
            /** @description Success */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Server Error */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    PrefetchReady: {
        parameters: {
            query?: {
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
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The server is currently starting or is temporarily not available. */
            503: {
                headers: {
                    /** @description A hint for when to retry the operation in full seconds. */
                    "Retry-After"?: number;
                    /** @description A short plain-text reason why the server is not available. */
                    Message?: string;
                    [name: string]: unknown;
                };
                content: {
                    "text/html": unknown;
                };
            };
        };
    };
    Progress: {
        parameters: {
            query?: {
                taskId?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The server is currently starting or is temporarily not available. */
            503: {
                headers: {
                    /** @description A hint for when to retry the operation in full seconds. */
                    "Retry-After"?: number;
                    /** @description A short plain-text reason why the server is not available. */
                    Message?: string;
                    [name: string]: unknown;
                };
                content: {
                    "text/html": unknown;
                };
            };
        };
    };
    GetThresholds: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The server is currently starting or is temporarily not available. */
            503: {
                headers: {
                    /** @description A hint for when to retry the operation in full seconds. */
                    "Retry-After"?: number;
                    /** @description A short plain-text reason why the server is not available. */
                    Message?: string;
                    [name: string]: unknown;
                };
                content: {
                    "text/html": unknown;
                };
            };
        };
    };
    SetThresholds: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["QualityThresholds"];
                "text/json": components["schemas"]["QualityThresholds"];
                "application/*+json": components["schemas"]["QualityThresholds"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The server is currently starting or is temporarily not available. */
            503: {
                headers: {
                    /** @description A hint for when to retry the operation in full seconds. */
                    "Retry-After"?: number;
                    /** @description A short plain-text reason why the server is not available. */
                    Message?: string;
                    [name: string]: unknown;
                };
                content: {
                    "text/html": unknown;
                };
            };
        };
    };
    DeleteResult: {
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
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The server is currently starting or is temporarily not available. */
            503: {
                headers: {
                    /** @description A hint for when to retry the operation in full seconds. */
                    "Retry-After"?: number;
                    /** @description A short plain-text reason why the server is not available. */
                    Message?: string;
                    [name: string]: unknown;
                };
                content: {
                    "text/html": unknown;
                };
            };
        };
    };
    GetResult: {
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
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The server is currently starting or is temporarily not available. */
            503: {
                headers: {
                    /** @description A hint for when to retry the operation in full seconds. */
                    "Retry-After"?: number;
                    /** @description A short plain-text reason why the server is not available. */
                    Message?: string;
                    [name: string]: unknown;
                };
                content: {
                    "text/html": unknown;
                };
            };
        };
    };
    GetTasks: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The server is currently starting or is temporarily not available. */
            503: {
                headers: {
                    /** @description A hint for when to retry the operation in full seconds. */
                    "Retry-After"?: number;
                    /** @description A short plain-text reason why the server is not available. */
                    Message?: string;
                    [name: string]: unknown;
                };
                content: {
                    "text/html": unknown;
                };
            };
        };
    };
    GetFrameInfo: {
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
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FrameIndexDto"];
                    "application/json; profile=\"PascalCase\"": components["schemas"]["FrameIndexDto"];
                    "application/json; profile=\"CamelCase\"": components["schemas"]["FrameIndexDto"];
                    "text/plain": components["schemas"]["FrameIndexDto"];
                    "text/json": components["schemas"]["FrameIndexDto"];
                    "text/css": components["schemas"]["FrameIndexDto"];
                    "text/xml": components["schemas"]["FrameIndexDto"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"PascalCase\"": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"CamelCase\"": components["schemas"]["ProblemDetails"];
                    "text/plain": components["schemas"]["ProblemDetails"];
                    "text/json": components["schemas"]["ProblemDetails"];
                    "text/css": components["schemas"]["ProblemDetails"];
                    "text/xml": components["schemas"]["ProblemDetails"];
                };
            };
            /** @description Server Error */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    GetConfig: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["GestureConfigDto"];
                    "application/json; profile=\"PascalCase\"": components["schemas"]["GestureConfigDto"];
                    "application/json; profile=\"CamelCase\"": components["schemas"]["GestureConfigDto"];
                    "text/plain": components["schemas"]["GestureConfigDto"];
                    "text/json": components["schemas"]["GestureConfigDto"];
                    "text/css": components["schemas"]["GestureConfigDto"];
                    "text/xml": components["schemas"]["GestureConfigDto"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The server is currently starting or is temporarily not available. */
            503: {
                headers: {
                    /** @description A hint for when to retry the operation in full seconds. */
                    "Retry-After"?: number;
                    /** @description A short plain-text reason why the server is not available. */
                    Message?: string;
                    [name: string]: unknown;
                };
                content: {
                    "text/html": unknown;
                };
            };
        };
    };
    SetConfig: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["GestureConfigDto"];
                "text/json": components["schemas"]["GestureConfigDto"];
                "application/*+json": components["schemas"]["GestureConfigDto"];
            };
        };
        responses: {
            /** @description Success */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"PascalCase\"": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"CamelCase\"": components["schemas"]["ProblemDetails"];
                    "text/plain": components["schemas"]["ProblemDetails"];
                    "text/json": components["schemas"]["ProblemDetails"];
                    "text/css": components["schemas"]["ProblemDetails"];
                    "text/xml": components["schemas"]["ProblemDetails"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The server is currently starting or is temporarily not available. */
            503: {
                headers: {
                    /** @description A hint for when to retry the operation in full seconds. */
                    "Retry-After"?: number;
                    /** @description A short plain-text reason why the server is not available. */
                    Message?: string;
                    [name: string]: unknown;
                };
                content: {
                    "text/html": unknown;
                };
            };
        };
    };
    GetCore: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The server is currently starting or is temporarily not available. */
            503: {
                headers: {
                    /** @description A hint for when to retry the operation in full seconds. */
                    "Retry-After"?: number;
                    /** @description A short plain-text reason why the server is not available. */
                    Message?: string;
                    [name: string]: unknown;
                };
                content: {
                    "text/html": unknown;
                };
            };
        };
    };
    Inject: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Server Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The server is currently starting or is temporarily not available. */
            503: {
                headers: {
                    /** @description A hint for when to retry the operation in full seconds. */
                    "Retry-After"?: number;
                    /** @description A short plain-text reason why the server is not available. */
                    Message?: string;
                    [name: string]: unknown;
                };
                content: {
                    "text/html": unknown;
                };
            };
        };
    };
    Remove: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Server Error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The server is currently starting or is temporarily not available. */
            503: {
                headers: {
                    /** @description A hint for when to retry the operation in full seconds. */
                    "Retry-After"?: number;
                    /** @description A short plain-text reason why the server is not available. */
                    Message?: string;
                    [name: string]: unknown;
                };
                content: {
                    "text/html": unknown;
                };
            };
        };
    };
    GetLauncher: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The server is currently starting or is temporarily not available. */
            503: {
                headers: {
                    /** @description A hint for when to retry the operation in full seconds. */
                    "Retry-After"?: number;
                    /** @description A short plain-text reason why the server is not available. */
                    Message?: string;
                    [name: string]: unknown;
                };
                content: {
                    "text/html": unknown;
                };
            };
        };
    };
    GetStatus: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["EnhancerStatusDto"];
                    "application/json; profile=\"PascalCase\"": components["schemas"]["EnhancerStatusDto"];
                    "application/json; profile=\"CamelCase\"": components["schemas"]["EnhancerStatusDto"];
                    "text/plain": components["schemas"]["EnhancerStatusDto"];
                    "text/json": components["schemas"]["EnhancerStatusDto"];
                    "text/css": components["schemas"]["EnhancerStatusDto"];
                    "text/xml": components["schemas"]["EnhancerStatusDto"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The server is currently starting or is temporarily not available. */
            503: {
                headers: {
                    /** @description A hint for when to retry the operation in full seconds. */
                    "Retry-After"?: number;
                    /** @description A short plain-text reason why the server is not available. */
                    Message?: string;
                    [name: string]: unknown;
                };
                content: {
                    "text/html": unknown;
                };
            };
        };
    };
    GetPlayHistory: {
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
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PlayHistoryResponse"];
                    "application/json; profile=\"PascalCase\"": components["schemas"]["PlayHistoryResponse"];
                    "application/json; profile=\"CamelCase\"": components["schemas"]["PlayHistoryResponse"];
                    "text/plain": components["schemas"]["PlayHistoryResponse"];
                    "text/json": components["schemas"]["PlayHistoryResponse"];
                    "text/css": components["schemas"]["PlayHistoryResponse"];
                    "text/xml": components["schemas"]["PlayHistoryResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"PascalCase\"": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"CamelCase\"": components["schemas"]["ProblemDetails"];
                    "text/plain": components["schemas"]["ProblemDetails"];
                    "text/json": components["schemas"]["ProblemDetails"];
                    "text/css": components["schemas"]["ProblemDetails"];
                    "text/xml": components["schemas"]["ProblemDetails"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The server is currently starting or is temporarily not available. */
            503: {
                headers: {
                    /** @description A hint for when to retry the operation in full seconds. */
                    "Retry-After"?: number;
                    /** @description A short plain-text reason why the server is not available. */
                    Message?: string;
                    [name: string]: unknown;
                };
                content: {
                    "text/html": unknown;
                };
            };
        };
    };
    StartJob: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                itemId: string;
            };
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["PosterSheetRequestDto"];
                "text/json": components["schemas"]["PosterSheetRequestDto"];
                "application/*+json": components["schemas"]["PosterSheetRequestDto"];
            };
        };
        responses: {
            /** @description Success */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StartJobResponseDto"];
                    "application/json; profile=\"PascalCase\"": components["schemas"]["StartJobResponseDto"];
                    "application/json; profile=\"CamelCase\"": components["schemas"]["StartJobResponseDto"];
                    "text/plain": components["schemas"]["StartJobResponseDto"];
                    "text/json": components["schemas"]["StartJobResponseDto"];
                    "text/css": components["schemas"]["StartJobResponseDto"];
                    "text/xml": components["schemas"]["StartJobResponseDto"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"PascalCase\"": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"CamelCase\"": components["schemas"]["ProblemDetails"];
                    "text/plain": components["schemas"]["ProblemDetails"];
                    "text/json": components["schemas"]["ProblemDetails"];
                    "text/css": components["schemas"]["ProblemDetails"];
                    "text/xml": components["schemas"]["ProblemDetails"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
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
                content: {
                    "application/json": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"PascalCase\"": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"CamelCase\"": components["schemas"]["ProblemDetails"];
                    "text/plain": components["schemas"]["ProblemDetails"];
                    "text/json": components["schemas"]["ProblemDetails"];
                    "text/css": components["schemas"]["ProblemDetails"];
                    "text/xml": components["schemas"]["ProblemDetails"];
                };
            };
            /** @description Client Error */
            422: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"PascalCase\"": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"CamelCase\"": components["schemas"]["ProblemDetails"];
                    "text/plain": components["schemas"]["ProblemDetails"];
                    "text/json": components["schemas"]["ProblemDetails"];
                    "text/css": components["schemas"]["ProblemDetails"];
                    "text/xml": components["schemas"]["ProblemDetails"];
                };
            };
            /** @description The server is currently starting or is temporarily not available. */
            503: {
                headers: {
                    /** @description A hint for when to retry the operation in full seconds. */
                    "Retry-After"?: number;
                    /** @description A short plain-text reason why the server is not available. */
                    Message?: string;
                    [name: string]: unknown;
                };
                content: {
                    "text/html": unknown;
                };
            };
        };
    };
    DeleteJob: {
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
            /** @description Success */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
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
                content: {
                    "application/json": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"PascalCase\"": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"CamelCase\"": components["schemas"]["ProblemDetails"];
                    "text/plain": components["schemas"]["ProblemDetails"];
                    "text/json": components["schemas"]["ProblemDetails"];
                    "text/css": components["schemas"]["ProblemDetails"];
                    "text/xml": components["schemas"]["ProblemDetails"];
                };
            };
            /** @description The server is currently starting or is temporarily not available. */
            503: {
                headers: {
                    /** @description A hint for when to retry the operation in full seconds. */
                    "Retry-After"?: number;
                    /** @description A short plain-text reason why the server is not available. */
                    Message?: string;
                    [name: string]: unknown;
                };
                content: {
                    "text/html": unknown;
                };
            };
        };
    };
    GetImage: {
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
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": string;
                    "application/json; profile=\"PascalCase\"": string;
                    "application/json; profile=\"CamelCase\"": string;
                    "text/plain": string;
                    "text/json": string;
                    "text/css": string;
                    "text/xml": string;
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
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
                content: {
                    "application/json": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"PascalCase\"": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"CamelCase\"": components["schemas"]["ProblemDetails"];
                    "text/plain": components["schemas"]["ProblemDetails"];
                    "text/json": components["schemas"]["ProblemDetails"];
                    "text/css": components["schemas"]["ProblemDetails"];
                    "text/xml": components["schemas"]["ProblemDetails"];
                };
            };
            /** @description Conflict */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"PascalCase\"": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"CamelCase\"": components["schemas"]["ProblemDetails"];
                    "text/plain": components["schemas"]["ProblemDetails"];
                    "text/json": components["schemas"]["ProblemDetails"];
                    "text/css": components["schemas"]["ProblemDetails"];
                    "text/xml": components["schemas"]["ProblemDetails"];
                };
            };
            /** @description The server is currently starting or is temporarily not available. */
            503: {
                headers: {
                    /** @description A hint for when to retry the operation in full seconds. */
                    "Retry-After"?: number;
                    /** @description A short plain-text reason why the server is not available. */
                    Message?: string;
                    [name: string]: unknown;
                };
                content: {
                    "text/html": unknown;
                };
            };
        };
    };
    GetStatus2: {
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
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PosterSheetStatusDto"];
                    "application/json; profile=\"PascalCase\"": components["schemas"]["PosterSheetStatusDto"];
                    "application/json; profile=\"CamelCase\"": components["schemas"]["PosterSheetStatusDto"];
                    "text/plain": components["schemas"]["PosterSheetStatusDto"];
                    "text/json": components["schemas"]["PosterSheetStatusDto"];
                    "text/css": components["schemas"]["PosterSheetStatusDto"];
                    "text/xml": components["schemas"]["PosterSheetStatusDto"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
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
                content: {
                    "application/json": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"PascalCase\"": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"CamelCase\"": components["schemas"]["ProblemDetails"];
                    "text/plain": components["schemas"]["ProblemDetails"];
                    "text/json": components["schemas"]["ProblemDetails"];
                    "text/css": components["schemas"]["ProblemDetails"];
                    "text/xml": components["schemas"]["ProblemDetails"];
                };
            };
            /** @description The server is currently starting or is temporarily not available. */
            503: {
                headers: {
                    /** @description A hint for when to retry the operation in full seconds. */
                    "Retry-After"?: number;
                    /** @description A short plain-text reason why the server is not available. */
                    Message?: string;
                    [name: string]: unknown;
                };
                content: {
                    "text/html": unknown;
                };
            };
        };
    };
    StreamStatus: {
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
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The server is currently starting or is temporarily not available. */
            503: {
                headers: {
                    /** @description A hint for when to retry the operation in full seconds. */
                    "Retry-After"?: number;
                    /** @description A short plain-text reason why the server is not available. */
                    Message?: string;
                    [name: string]: unknown;
                };
                content: {
                    "text/html": unknown;
                };
            };
        };
    };
    CheckCache: {
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
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CacheCheckResponseDto"];
                    "application/json; profile=\"PascalCase\"": components["schemas"]["CacheCheckResponseDto"];
                    "application/json; profile=\"CamelCase\"": components["schemas"]["CacheCheckResponseDto"];
                    "text/plain": components["schemas"]["CacheCheckResponseDto"];
                    "text/json": components["schemas"]["CacheCheckResponseDto"];
                    "text/css": components["schemas"]["CacheCheckResponseDto"];
                    "text/xml": components["schemas"]["CacheCheckResponseDto"];
                };
            };
            /** @description Success */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The server is currently starting or is temporarily not available. */
            503: {
                headers: {
                    /** @description A hint for when to retry the operation in full seconds. */
                    "Retry-After"?: number;
                    /** @description A short plain-text reason why the server is not available. */
                    Message?: string;
                    [name: string]: unknown;
                };
                content: {
                    "text/html": unknown;
                };
            };
        };
    };
    ListUserFonts: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The server is currently starting or is temporarily not available. */
            503: {
                headers: {
                    /** @description A hint for when to retry the operation in full seconds. */
                    "Retry-After"?: number;
                    /** @description A short plain-text reason why the server is not available. */
                    Message?: string;
                    [name: string]: unknown;
                };
                content: {
                    "text/html": unknown;
                };
            };
        };
    };
    UploadFont: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "multipart/form-data": {
                    /** Format: binary */
                    file?: string;
                };
            };
        };
        responses: {
            /** @description Success */
            200: {
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
                content: {
                    "application/json": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"PascalCase\"": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"CamelCase\"": components["schemas"]["ProblemDetails"];
                    "text/plain": components["schemas"]["ProblemDetails"];
                    "text/json": components["schemas"]["ProblemDetails"];
                    "text/css": components["schemas"]["ProblemDetails"];
                    "text/xml": components["schemas"]["ProblemDetails"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The server is currently starting or is temporarily not available. */
            503: {
                headers: {
                    /** @description A hint for when to retry the operation in full seconds. */
                    "Retry-After"?: number;
                    /** @description A short plain-text reason why the server is not available. */
                    Message?: string;
                    [name: string]: unknown;
                };
                content: {
                    "text/html": unknown;
                };
            };
        };
    };
    DeleteUserFont: {
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
            /** @description Success */
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
                content: {
                    "application/json": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"PascalCase\"": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"CamelCase\"": components["schemas"]["ProblemDetails"];
                    "text/plain": components["schemas"]["ProblemDetails"];
                    "text/json": components["schemas"]["ProblemDetails"];
                    "text/css": components["schemas"]["ProblemDetails"];
                    "text/xml": components["schemas"]["ProblemDetails"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
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
                content: {
                    "application/json": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"PascalCase\"": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"CamelCase\"": components["schemas"]["ProblemDetails"];
                    "text/plain": components["schemas"]["ProblemDetails"];
                    "text/json": components["schemas"]["ProblemDetails"];
                    "text/css": components["schemas"]["ProblemDetails"];
                    "text/xml": components["schemas"]["ProblemDetails"];
                };
            };
            /** @description The server is currently starting or is temporarily not available. */
            503: {
                headers: {
                    /** @description A hint for when to retry the operation in full seconds. */
                    "Retry-After"?: number;
                    /** @description A short plain-text reason why the server is not available. */
                    Message?: string;
                    [name: string]: unknown;
                };
                content: {
                    "text/html": unknown;
                };
            };
        };
    };
    ListJobs: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PosterSheetStatusDto"][];
                    "application/json; profile=\"PascalCase\"": components["schemas"]["PosterSheetStatusDto"][];
                    "application/json; profile=\"CamelCase\"": components["schemas"]["PosterSheetStatusDto"][];
                    "text/plain": components["schemas"]["PosterSheetStatusDto"][];
                    "text/json": components["schemas"]["PosterSheetStatusDto"][];
                    "text/css": components["schemas"]["PosterSheetStatusDto"][];
                    "text/xml": components["schemas"]["PosterSheetStatusDto"][];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The server is currently starting or is temporarily not available. */
            503: {
                headers: {
                    /** @description A hint for when to retry the operation in full seconds. */
                    "Retry-After"?: number;
                    /** @description A short plain-text reason why the server is not available. */
                    Message?: string;
                    [name: string]: unknown;
                };
                content: {
                    "text/html": unknown;
                };
            };
        };
    };
    Preview: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: {
            content: {
                "application/json": components["schemas"]["PreviewRequestDto"];
                "text/json": components["schemas"]["PreviewRequestDto"];
                "application/*+json": components["schemas"]["PreviewRequestDto"];
            };
        };
        responses: {
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": string;
                    "application/json; profile=\"PascalCase\"": string;
                    "application/json; profile=\"CamelCase\"": string;
                    "text/plain": string;
                    "text/json": string;
                    "text/css": string;
                    "text/xml": string;
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"PascalCase\"": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"CamelCase\"": components["schemas"]["ProblemDetails"];
                    "text/plain": components["schemas"]["ProblemDetails"];
                    "text/json": components["schemas"]["ProblemDetails"];
                    "text/css": components["schemas"]["ProblemDetails"];
                    "text/xml": components["schemas"]["ProblemDetails"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Server Error */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    GetFrame2: {
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
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": string;
                    "application/json; profile=\"PascalCase\"": string;
                    "application/json; profile=\"CamelCase\"": string;
                    "text/plain": string;
                    "text/json": string;
                    "text/css": string;
                    "text/xml": string;
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"PascalCase\"": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"CamelCase\"": components["schemas"]["ProblemDetails"];
                    "text/plain": components["schemas"]["ProblemDetails"];
                    "text/json": components["schemas"]["ProblemDetails"];
                    "text/css": components["schemas"]["ProblemDetails"];
                    "text/xml": components["schemas"]["ProblemDetails"];
                };
            };
            /** @description Server Error */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    GetFrameIndex: {
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
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FrameIndexDto"];
                    "application/json; profile=\"PascalCase\"": components["schemas"]["FrameIndexDto"];
                    "application/json; profile=\"CamelCase\"": components["schemas"]["FrameIndexDto"];
                    "text/plain": components["schemas"]["FrameIndexDto"];
                    "text/json": components["schemas"]["FrameIndexDto"];
                    "text/css": components["schemas"]["FrameIndexDto"];
                    "text/xml": components["schemas"]["FrameIndexDto"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"PascalCase\"": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"CamelCase\"": components["schemas"]["ProblemDetails"];
                    "text/plain": components["schemas"]["ProblemDetails"];
                    "text/json": components["schemas"]["ProblemDetails"];
                    "text/css": components["schemas"]["ProblemDetails"];
                    "text/xml": components["schemas"]["ProblemDetails"];
                };
            };
            /** @description Server Error */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    GetFrameInfo2: {
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
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FrameInfoDto"];
                    "application/json; profile=\"PascalCase\"": components["schemas"]["FrameInfoDto"];
                    "application/json; profile=\"CamelCase\"": components["schemas"]["FrameInfoDto"];
                    "text/plain": components["schemas"]["FrameInfoDto"];
                    "text/json": components["schemas"]["FrameInfoDto"];
                    "text/css": components["schemas"]["FrameInfoDto"];
                    "text/xml": components["schemas"]["FrameInfoDto"];
                };
            };
            /** @description Not Found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"PascalCase\"": components["schemas"]["ProblemDetails"];
                    "application/json; profile=\"CamelCase\"": components["schemas"]["ProblemDetails"];
                    "text/plain": components["schemas"]["ProblemDetails"];
                    "text/json": components["schemas"]["ProblemDetails"];
                    "text/css": components["schemas"]["ProblemDetails"];
                    "text/xml": components["schemas"]["ProblemDetails"];
                };
            };
            /** @description Server Error */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    ReadyStream: {
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
            /** @description Success */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description The server is currently starting or is temporarily not available. */
            503: {
                headers: {
                    /** @description A hint for when to retry the operation in full seconds. */
                    "Retry-After"?: number;
                    /** @description A short plain-text reason why the server is not available. */
                    Message?: string;
                    [name: string]: unknown;
                };
                content: {
                    "text/html": unknown;
                };
            };
        };
    };
}

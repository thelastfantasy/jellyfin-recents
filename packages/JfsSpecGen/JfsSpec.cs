using Jellyfin.Plugin.JellyfinSuite.Models;
using Jellyfin.Plugin.JellyfinSuite.Services;

namespace JfsSpecGen;

static class JfsSpec
{
    // All DTO types with [JsonPropertyName] attributes — reflected automatically.
    static readonly Type[] DtoTypes =
    [
        // FrameExport
        typeof(PrefetchRangeStreamRequest),
        typeof(PrefetchRequest),
        typeof(FramePairDto),
        typeof(GenerateRequest),
        typeof(FrameReference),
        typeof(ExportParams),
        typeof(GenerateResponse),
        typeof(TaskProgressDto),
        typeof(QualityThresholds),
        typeof(FrameExportTaskListItemDto),
        typeof(HwDecodeSettingsDto),
        typeof(HwDecodeSettingsUpdateDto),
        // FrameInfo / FrameIndex
        typeof(FrameInfoDto),
        typeof(FrameIndexDto),
        typeof(FrameIndexEntryDto),
        typeof(FpsFracDto),
        // PosterSheet
        typeof(PosterSheetStatusDto),
        typeof(StartJobResponseDto),
        typeof(CacheCheckResponseDto),
        typeof(SkipSegmentDto),
        typeof(PosterSheetRequestDto),
        typeof(PreviewRequestDto),
        typeof(OverlaySettings),
        typeof(MediaInfoDto),
        // PlayHistory
        typeof(PlayHistoryEntry),
        typeof(PlayHistoryResponse),
        // Stitch: device enumeration
        typeof(ComputeDeviceDto),
        typeof(DeviceListDto),
        // Stitch: model catalog
        typeof(ModelEntryDto),
        typeof(ModelListDto),
        typeof(ModelDownloadRequestDto),
        typeof(ModelDownloadProgressDto),
        // Stitch: ORT version management
        typeof(OrtAssetDto),
        typeof(OrtVersionDto),
        typeof(OrtVersionListDto),
        typeof(OrtDownloadRequestDto),
        typeof(OrtActivateRequestDto),
        typeof(OrtDownloadProgressDto),
        // Stitch: upscale (US7)
        typeof(FallbackEventDto),
        typeof(UpscaleLogDto),
        typeof(UpscaleStartRequestDto),
        typeof(UpscaleJobDto),
        typeof(UpscaleJobLogDto),
    ];

    public static Dictionary<string, object> Build()
    {
        var doc = new OaDoc();

        foreach (var t in DtoTypes)
            doc.AddSchema(t.Name, SchemaReflector.ReflectType(t));

        doc.AddSchema("FontMetaRecord",          FontMetaRecordSchema());
        doc.AddSchema("FrameExportHealth",       FrameExportHealthSchema());
        doc.AddSchema("SeekReadyEvent",          SeekReadyEventSchema());
        doc.AddSchema("FrameIndexStreamEvent",   FrameIndexStreamEventSchema());
        doc.AddSchema("PrefetchRangeEvent",      PrefetchRangeEventSchema());

        AddPlayHistoryPaths(doc);
        AddJellyfinSuitePaths(doc);
        AddSeekPreviewPaths(doc);
        AddFrameExportPaths(doc);
        AddPosterSheetPaths(doc);
        AddStitchPaths(doc);

        return doc.Build();
    }

    // ── Manual schemas ──────────────────────────────────────────────────

    static Dictionary<string, object> FontMetaRecordSchema() => new()
    {
        ["type"] = "object",
        ["required"] = new[] { "key", "displayName", "script", "format" },
        ["properties"] = new Dictionary<string, object>
        {
            ["key"]           = Str(),
            ["displayName"]   = Str(),
            ["script"]        = Str(),
            ["format"]        = Str(),
            ["isSerif"]       = NullableBool(),
            ["isMonospace"]   = NullableBool(),
            ["isBold"]        = NullableBool(),
            ["isItalic"]      = NullableBool(),
            ["hasLigatures"]  = NullableBool(),
        },
    };

    static Dictionary<string, object> FrameExportHealthSchema() => new()
    {
        ["type"] = "object",
        ["required"] = new[] { "available", "activeTasks" },
        ["properties"] = new Dictionary<string, object>
        {
            ["available"]    = new Dictionary<string, object> { ["type"] = "boolean" },
            ["activeTasks"]  = new Dictionary<string, object> { ["type"] = "integer", ["format"] = "int32" },
        },
    };

    static Dictionary<string, object> SeekReadyEventSchema() => new()
    {
        ["type"] = "object",
        ["required"] = new[] { "frameReady" },
        ["properties"] = new Dictionary<string, object>
        {
            ["frameReady"] = new Dictionary<string, object> { ["type"] = "integer", ["format"] = "int64" },
        },
    };

    // FrameInfoStream: each SSE data field is either a batch of frame entries
    // (array) or the terminal fps signal {"fps":{num,den}}.
    static Dictionary<string, object> FrameIndexStreamEventSchema() => new()
    {
        ["anyOf"] = new object[]
        {
            new Dictionary<string, object>
            {
                ["type"] = "array",
                ["items"] = new Dictionary<string, object> { ["$ref"] = "#/components/schemas/FrameIndexEntryDto" },
            },
            new Dictionary<string, object>
            {
                ["type"] = "object",
                ["required"] = new[] { "fps" },
                ["properties"] = new Dictionary<string, object>
                {
                    ["fps"] = new Dictionary<string, object> { ["$ref"] = "#/components/schemas/FpsFracDto" },
                },
            },
        },
    };

    // PrefetchRangeStream: each SSE data field is either {"frameReady": fi_idx}
    // (a frame is ready in cache) or {"done": true} (stream complete).
    static Dictionary<string, object> PrefetchRangeEventSchema() => new()
    {
        ["anyOf"] = new object[]
        {
            new Dictionary<string, object>
            {
                ["type"] = "object",
                ["required"] = new[] { "frameReady" },
                ["properties"] = new Dictionary<string, object>
                {
                    ["frameReady"] = new Dictionary<string, object> { ["type"] = "integer", ["format"] = "int64" },
                },
            },
            new Dictionary<string, object>
            {
                ["type"] = "object",
                ["required"] = new[] { "done" },
                ["properties"] = new Dictionary<string, object>
                {
                    ["done"] = new Dictionary<string, object> { ["type"] = "boolean" },
                },
            },
        },
    };

    static Dictionary<string, object> Str() => new() { ["type"] = "string" };
    static Dictionary<string, object> NullableBool() => new()
    {
        ["anyOf"] = new object[]
        {
            new Dictionary<string, object> { ["type"] = "boolean" },
            new Dictionary<string, object> { ["type"] = "null" },
        },
    };

    // ── PlayHistory ─────────────────────────────────────────────────────

    static void AddPlayHistoryPaths(OaDoc doc)
    {
        doc.AddPath("/JellyfinSuite/PlayHistory", "get", new OaOp()
            .Tag("PlayHistory").OpId("playHistory_get")
            .QueryParam("groupBy", "string")
            .QueryParamInt("page")
            .QueryParam("tz", "string")
            .QueryParam("sortBy", "string")
            .QueryParam("sortOrder", "string")
            .QueryParam("mediaType", "string")
            .QueryParamBool("showRepeats")
            .QueryParamBool("groupDedup")
            .QueryParamInt("pageSize")
            .ResRef(200, "Play history", "PlayHistoryResponse")
            .ResNoContent(401, "Unauthorized"));
    }

    // ── JellyfinSuite common ────────────────────────────────────────────

    static void AddJellyfinSuitePaths(OaDoc doc)
    {
        doc.AddPath("/JellyfinSuite/{itemId}/FrameInfo", "get", new OaOp()
            .Tag("JellyfinSuite").OpId("jellyfinSuite_getFrameInfo")
            .PathParam("itemId", "string", "uuid")
            .ResRef(200, "Frame index", "FrameIndexDto")
            .ResNoContent(404, "Not Found").ResNoContent(503, "Service Unavailable"));

        doc.AddPath("/JellyfinSuite/{itemId}/FrameInfoStream", "get", new OaOp()
            .Tag("JellyfinSuite").OpId("jellyfinSuite_frameInfoStream")
            .PathParam("itemId", "string", "uuid")
            .QueryParamInt("currentTimeMs")
            .Sse(200, "FrameIndexStreamEvent")
            .ResNoContent(404, "Not Found").ResNoContent(503, "Service Unavailable"));
    }

    // ── SeekPreview ─────────────────────────────────────────────────────

    static void AddSeekPreviewPaths(OaDoc doc)
    {
        doc.AddPath("/JellyfinSuite/SeekPreview/{itemId}", "get", new OaOp()
            .Tag("SeekPreview").OpId("seekPreview_getFrame")
            .PathParam("itemId", "string", "uuid")
            .QueryParamInt("positionMs")
            .QueryParamBool("prefetch")
            .QueryParamInt("width")
            .ResBinary(200, "JPEG frame", "image/jpeg")
            .ResNoContent(404, "Not Found").ResNoContent(503, "Service Unavailable"));

        doc.AddPath("/JellyfinSuite/SeekPreview/{itemId}/frame-info", "get", new OaOp()
            .Tag("SeekPreview").OpId("seekPreview_getFrameInfo")
            .PathParam("itemId", "string", "uuid")
            .QueryParamInt("positionMs")
            .ResRef(200, "Frame info", "FrameInfoDto")
            .ResNoContent(404, "Not Found").ResNoContent(503, "Service Unavailable"));

        doc.AddPath("/JellyfinSuite/SeekPreview/{itemId}/frame-index", "get", new OaOp()
            .Tag("SeekPreview").OpId("seekPreview_getFrameIndex")
            .PathParam("itemId", "string", "uuid")
            .ResRef(200, "Frame index", "FrameIndexDto")
            .ResNoContent(404, "Not Found").ResNoContent(503, "Service Unavailable"));

        doc.AddPath("/JellyfinSuite/SeekPreview/{itemId}/ready-stream", "get", new OaOp()
            .Tag("SeekPreview").OpId("seekPreview_readyStream")
            .PathParam("itemId", "string", "uuid")
            .QueryParamInt("positionMs")
            .Sse(200, "SeekReadyEvent")
            .ResNoContent(404, "Not Found").ResNoContent(503, "Service Unavailable"));
    }

    // ── FrameExport ─────────────────────────────────────────────────────

    static void AddFrameExportPaths(OaDoc doc)
    {
        doc.AddPath("/JellyfinSuite/FrameExport/{itemId}", "get", new OaOp()
            .Tag("FrameExport").OpId("frameExport_getFrame")
            .PathParam("itemId", "string", "uuid")
            .QueryParamInt("frameIdx")
            .QueryParamInt("positionMs")
            .QueryParamInt("width")
            .ResBinary(200, "WebP frame", "image/webp")
            .ResNoContent(404, "Not Found").ResNoContent(503, "Service Unavailable"));

        doc.AddPath("/JellyfinSuite/FrameExport/Prefetch/{itemId}", "post", new OaOp()
            .Tag("FrameExport").OpId("frameExport_prefetch")
            .PathParam("itemId", "string", "uuid")
            .Body("PrefetchRequest")
            .ResNoContent(202, "Accepted").ResNoContent(503, "Service Unavailable"));

        doc.AddPath("/JellyfinSuite/FrameExport/PrefetchReady/{itemId}", "post", new OaOp()
            .Tag("FrameExport").OpId("frameExport_prefetchReady")
            .PathParam("itemId", "string", "uuid")
            .Body("PrefetchRangeStreamRequest")
            .Sse(200, "PrefetchRangeEvent")
            .ResNoContent(404, "Not Found").ResNoContent(503, "Service Unavailable"));

        doc.AddPath("/JellyfinSuite/FrameExport/Generate", "post", new OaOp()
            .Tag("FrameExport").OpId("frameExport_generate")
            .Body("GenerateRequest")
            .ResRef(202, "Task accepted", "GenerateResponse")
            .ResNoContent(400, "Bad Request"));

        doc.AddPath("/JellyfinSuite/FrameExport/TaskProgress", "get", new OaOp()
            .Tag("FrameExport").OpId("frameExport_taskProgress")
            .QueryParam("taskId", "string", required: true)
            .Sse(200, "TaskProgressDto")
            .ResNoContent(404, "Not Found"));

        doc.AddPath("/JellyfinSuite/FrameExport/Result/{taskId}/{filename}", "get", new OaOp()
            .Tag("FrameExport").OpId("frameExport_getResult")
            .PathParam("taskId").PathParam("filename")
            .ResBinary(200, "Result file")
            .ResNoContent(404, "Not Found").ResNoContent(409, "Conflict"));

        doc.AddPath("/JellyfinSuite/FrameExport/Result/{taskId}", "delete", new OaOp()
            .Tag("FrameExport").OpId("frameExport_deleteResult")
            .PathParam("taskId")
            .ResNoContent(200, "Deleted").ResNoContent(404, "Not Found"));

        doc.AddPath("/JellyfinSuite/FrameExport/Cancel/{taskId}", "post", new OaOp()
            .Tag("FrameExport").OpId("frameExport_cancel")
            .PathParam("taskId")
            .ResNoContent(200, "Cancelled")
            .ResNoContent(404, "Not Found").ResNoContent(409, "Already complete"));

        doc.AddPath("/JellyfinSuite/FrameExport/Tasks", "get", new OaOp()
            .Tag("FrameExport").OpId("frameExport_getTasks")
            .ResArray(200, "Task list", "FrameExportTaskListItemDto"));

        doc.AddPath("/JellyfinSuite/FrameExport/Health", "get", new OaOp()
            .Tag("FrameExport").OpId("frameExport_health")
            .ResRef(200, "Health info", "FrameExportHealth"));

        doc.AddPath("/JellyfinSuite/FrameExport/Debug", "get", new OaOp()
            .Tag("FrameExport").OpId("frameExport_debug")
            .ResNoContent(200, "Debug JSON").ResNoContent(503, "Service Unavailable"));

        doc.AddPath("/JellyfinSuite/FrameExport/QualityThresholds", "get", new OaOp()
            .Tag("FrameExport").OpId("frameExport_getQualityThresholds")
            .ResRef(200, "Quality thresholds", "QualityThresholds"));

        doc.AddPath("/JellyfinSuite/FrameExport/QualityThresholds", "put", new OaOp()
            .Tag("FrameExport").OpId("frameExport_setQualityThresholds")
            .Body("QualityThresholds")
            .ResRef(200, "Updated thresholds", "QualityThresholds"));

        doc.AddPath("/JellyfinSuite/FrameExport/HwDecodeSettings", "get", new OaOp()
            .Tag("FrameExport").OpId("frameExport_getHwDecodeSettings")
            .ResRef(200, "Hardware decode settings", "HwDecodeSettingsDto"));

        doc.AddPath("/JellyfinSuite/FrameExport/HwDecodeSettings", "put", new OaOp()
            .Tag("FrameExport").OpId("frameExport_setHwDecodeSettings")
            .Body("HwDecodeSettingsUpdateDto")
            .ResRef(200, "Updated hardware decode settings", "HwDecodeSettingsDto"));
    }

    // ── PosterSheet ─────────────────────────────────────────────────────

    static void AddPosterSheetPaths(OaDoc doc)
    {
        doc.AddPath("/JellyfinSuite/PosterSheet/{id}", "post", new OaOp()
            .Tag("PosterSheet").OpId("posterSheet_startJob")
            .PathParam("id", "string", "uuid")
            .Body("PosterSheetRequestDto")
            .ResRef(202, "Job started", "StartJobResponseDto")
            .ResNoContent(400, "Bad Request").ResNoContent(404, "Not Found")
            .ResNoContent(422, "Unprocessable Entity"));

        doc.AddPath("/JellyfinSuite/PosterSheet/jobs", "get", new OaOp()
            .Tag("PosterSheet").OpId("posterSheet_listJobs")
            .ResArray(200, "Job list", "PosterSheetStatusDto"));

        doc.AddPath("/JellyfinSuite/PosterSheet/{jobId}/status", "get", new OaOp()
            .Tag("PosterSheet").OpId("posterSheet_getStatus")
            .PathParam("jobId")
            .ResRef(200, "Job status", "PosterSheetStatusDto")
            .ResNoContent(404, "Not Found"));

        doc.AddPath("/JellyfinSuite/PosterSheet/{jobId}/image", "get", new OaOp()
            .Tag("PosterSheet").OpId("posterSheet_getImage")
            .PathParam("jobId")
            .ResBinary(200, "Poster sheet image", "image/webp")
            .ResNoContent(404, "Not Found").ResNoContent(409, "Conflict"));

        doc.AddPath("/JellyfinSuite/PosterSheet/{jobId}/stream", "get", new OaOp()
            .Tag("PosterSheet").OpId("posterSheet_streamStatus")
            .PathParam("jobId")
            .Sse(200, "PosterSheetStatusDto")
            .ResNoContent(404, "Not Found"));

        doc.AddPath("/JellyfinSuite/PosterSheet/{id}", "delete", new OaOp()
            .Tag("PosterSheet").OpId("posterSheet_deleteJob")
            .PathParam("id")
            .ResNoContent(204, "No Content").ResNoContent(404, "Not Found"));

        doc.AddPath("/JellyfinSuite/PosterSheet/preview", "post", new OaOp()
            .Tag("PosterSheet").OpId("posterSheet_preview")
            .Body("PreviewRequestDto")
            .ResBinary(200, "Preview image", "image/webp")
            .ResNoContent(400, "Bad Request").ResNoContent(503, "Service Unavailable"));

        doc.AddPath("/JellyfinSuite/PosterSheet/cache/{itemId}", "get", new OaOp()
            .Tag("PosterSheet").OpId("posterSheet_checkCache")
            .PathParam("itemId")
            .QueryParamInt("rows").QueryParamInt("cols").QueryParamInt("thumbWidth")
            .QueryParam("seed", "string").QueryParam("overlayHash", "string")
            .ResRef(200, "Cache hit", "CacheCheckResponseDto")
            .ResNoContent(204, "Not cached"));

        doc.AddPath("/JellyfinSuite/PosterSheet/fonts", "get", new OaOp()
            .Tag("PosterSheet").OpId("posterSheet_listFonts")
            .ResArray(200, "Font list", "FontMetaRecord"));

        doc.AddPath("/JellyfinSuite/PosterSheet/fonts", "post", new OaOp()
            .Tag("PosterSheet").OpId("posterSheet_uploadFont")
            .BodyFile()
            .ResRef(200, "Uploaded font", "FontMetaRecord")
            .ResNoContent(400, "Bad Request"));

        doc.AddPath("/JellyfinSuite/PosterSheet/fonts/{key}", "delete", new OaOp()
            .Tag("PosterSheet").OpId("posterSheet_deleteFont")
            .PathParam("key")
            .ResNoContent(204, "No Content")
            .ResNoContent(400, "Bad Request").ResNoContent(404, "Not Found"));
    }

    // ── Stitch (device enumeration, model catalog, ORT versions, upscale) ──

    static void AddStitchPaths(OaDoc doc)
    {
        doc.AddPath("/JellyfinSuite/Stitch/Devices", "get", new OaOp()
            .Tag("Stitch").OpId("stitch_getDevices")
            .ResRef(200, "Compute device list", "DeviceListDto"));

        doc.AddPath("/JellyfinSuite/Stitch/Models", "get", new OaOp()
            .Tag("Stitch").OpId("stitch_getModels")
            .ResRef(200, "Model catalog", "ModelListDto"));

        doc.AddPath("/JellyfinSuite/Stitch/Models/Download", "post", new OaOp()
            .Tag("Stitch").OpId("stitch_downloadModel")
            .Body("ModelDownloadRequestDto")
            .ResNoContent(202, "Accepted")
            .ResNoContent(404, "Version not found in catalog")
            .ResNoContent(409, "Already installed or in progress"));

        doc.AddPath("/JellyfinSuite/Stitch/Models/DownloadProgress", "get", new OaOp()
            .Tag("Stitch").OpId("stitch_getModelDownloadProgress")
            .QueryParam("family", "string", required: true)
            .QueryParam("version", "string", required: true)
            .Sse(200, "ModelDownloadProgressDto"));

        doc.AddPath("/JellyfinSuite/Stitch/Models/{family}/{version}", "delete", new OaOp()
            .Tag("Stitch").OpId("stitch_deleteModel")
            .PathParam("family").PathParam("version")
            .ResNoContent(200, "Deleted").ResNoContent(409, "Conflict"));

        doc.AddPath("/JellyfinSuite/Stitch/OrtVersions", "get", new OaOp()
            .Tag("Stitch").OpId("stitch_getOrtVersions")
            .ResRef(200, "ORT version list", "OrtVersionListDto"));

        doc.AddPath("/JellyfinSuite/Stitch/OrtVersions/Download", "post", new OaOp()
            .Tag("Stitch").OpId("stitch_downloadOrtVersion")
            .Body("OrtDownloadRequestDto")
            .ResNoContent(202, "Accepted").ResNoContent(404, "Version not found in catalog"));

        doc.AddPath("/JellyfinSuite/Stitch/OrtVersions/Activate", "post", new OaOp()
            .Tag("Stitch").OpId("stitch_activateOrtVersion")
            .Body("OrtActivateRequestDto")
            .ResNoContent(200, "Activated").ResNoContent(404, "Version not installed"));

        doc.AddPath("/JellyfinSuite/Stitch/OrtVersions/DownloadProgress", "get", new OaOp()
            .Tag("Stitch").OpId("stitch_getOrtDownloadProgress")
            .QueryParam("version", "string", required: true)
            .Sse(200, "OrtDownloadProgressDto"));

        // ── Upscale (US7) ───────────────────────────────────────────────
        doc.AddPath("/JellyfinSuite/Stitch/Upscale", "post", new OaOp()
            .Tag("Stitch").OpId("stitch_startUpscale")
            .Body("UpscaleStartRequestDto")
            .ResRef(202, "Job accepted", "UpscaleJobDto")
            .ResNoContent(404, "Source result not found or expired"));

        doc.AddPath("/JellyfinSuite/Stitch/Upscale/{jobId}", "get", new OaOp()
            .Tag("Stitch").OpId("stitch_getUpscaleStatus")
            .PathParam("jobId")
            .ResRef(200, "Job status", "UpscaleJobDto")
            .ResNoContent(404, "Job not found"));

        doc.AddPath("/JellyfinSuite/Stitch/Upscale/{jobId}/Result", "get", new OaOp()
            .Tag("Stitch").OpId("stitch_getUpscaleResult")
            .PathParam("jobId")
            .ResBinary(200, "Upscaled image (not yet confirmed)")
            .ResNoContent(404, "Result not available"));

        doc.AddPath("/JellyfinSuite/Stitch/Upscale/{jobId}/Log", "get", new OaOp()
            .Tag("Stitch").OpId("stitch_getUpscaleLog")
            .PathParam("jobId")
            .ResRef(200, "Job diagnostics", "UpscaleJobLogDto")
            .ResNoContent(404, "Job not found"));

        doc.AddPath("/JellyfinSuite/Stitch/Upscale/{jobId}/Cancel", "post", new OaOp()
            .Tag("Stitch").OpId("stitch_cancelUpscale")
            .PathParam("jobId")
            .ResNoContent(200, "Cancelled").ResNoContent(404, "Job not found"));
    }
}

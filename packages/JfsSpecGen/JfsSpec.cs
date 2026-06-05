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
        typeof(FrameQualityMeta),
        typeof(QualityThresholds),
        typeof(FrameExportTaskListItemDto),
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
    ];

    public static Dictionary<string, object> Build()
    {
        var doc = new OaDoc();

        foreach (var t in DtoTypes)
            doc.AddSchema(t.Name, SchemaReflector.ReflectType(t));

        doc.AddSchema("FontMetaRecord",       FontMetaRecordSchema());
        doc.AddSchema("FrameExportHealth",    FrameExportHealthSchema());
        doc.AddSchema("SeekReadyEvent",       SeekReadyEventSchema());
        doc.AddSchema("PrefetchFrameEvent",   PrefetchFrameEventSchema());

        AddPlayHistoryPaths(doc);
        AddJellyfinSuitePaths(doc);
        AddSeekPreviewPaths(doc);
        AddFrameExportPaths(doc);
        AddPosterSheetPaths(doc);

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

    static Dictionary<string, object> PrefetchFrameEventSchema() => new()
    {
        ["type"] = "object",
        ["properties"] = new Dictionary<string, object>
        {
            ["posMs"] = new Dictionary<string, object> { ["type"] = "integer", ["format"] = "int64" },
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
            .Sse(200, "FrameIndexEntryDto")
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
            .Sse(200, "PrefetchFrameEvent")
            .ResNoContent(503, "Service Unavailable"));

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
    }

    // ── PosterSheet ─────────────────────────────────────────────────────

    static void AddPosterSheetPaths(OaDoc doc)
    {
        doc.AddPath("/JellyfinSuite/PosterSheet/{itemId}", "post", new OaOp()
            .Tag("PosterSheet").OpId("posterSheet_startJob")
            .PathParam("itemId")
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

        doc.AddPath("/JellyfinSuite/PosterSheet/{jobId}", "delete", new OaOp()
            .Tag("PosterSheet").OpId("posterSheet_deleteJob")
            .PathParam("jobId")
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
}

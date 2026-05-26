using Jellyfin.Plugin.JellyfinSuite.Data;
using Jellyfin.Plugin.JellyfinSuite.Events;
using Jellyfin.Plugin.JellyfinSuite.i18n;
using Jellyfin.Plugin.JellyfinSuite.Services;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Events;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Plugins;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.JellyfinSuite;

/// <summary>
/// Registers plugin services with Jellyfin's DI container.
/// </summary>
public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        // RecentsDatabase 是单例——整个进程共享同一数据库连接字符串
        serviceCollection.AddSingleton<RecentsDatabase>(sp =>
        {
            var appPaths = applicationHost.Resolve<MediaBrowser.Common.Configuration.IApplicationPaths>();
            var logger = sp.GetRequiredService<Microsoft.Extensions.Logging.ILogger<RecentsDatabase>>();
            var dbPath = Path.Combine(appPaths.DataPath, PluginConstants.DatabaseFileName);
            var legacyPath = Path.Combine(appPaths.DataPath, PluginConstants.DatabaseFileNameLegacy);
            RecentsDatabase.MigrateFromLegacy(legacyPath, dbPath, logger);
            var db = new RecentsDatabase(dbPath, logger);
            db.Initialize();
            return db;
        });

        serviceCollection.AddScoped<PlayHistoryService>();

        // 播放事件：经过 IEventManager，可用 IEventConsumer<T>
        serviceCollection.AddTransient<IEventConsumer<PlaybackStartEventArgs>, PlaybackStartedEventConsumer>();

        // 收藏事件：IUserDataManager.UserDataSaved 是老式 C# event，不经过 IEventManager，
        // 必须用 IHostedService 手动订阅
        serviceCollection.AddHostedService<FavoriteEntryPoint>();

        // 播放器增强：启动时幂等追加 enhancer URL 到 web/config.json
        serviceCollection.AddHostedService<PlayerEnhancerEntryPoint>();

        // SeekPreviewService: 单例，管理 seek-preview Rust daemon 进程和 Unix socket 连接
        serviceCollection.AddSingleton<SeekPreviewService>(sp =>
        {
            var appPaths = applicationHost.Resolve<MediaBrowser.Common.Configuration.IApplicationPaths>();
            var logger = sp.GetRequiredService<ILogger<SeekPreviewService>>();
            return new SeekPreviewService(appPaths, logger);
        });

        // SeekPreviewBatchService: 持久后台任务队列，跨视频优先级管理，SSE 断开后继续运行
        serviceCollection.AddSingleton<SeekPreviewBatchService>(sp =>
        {
            var seekPreview = sp.GetRequiredService<SeekPreviewService>();
            var logger = sp.GetRequiredService<ILogger<SeekPreviewBatchService>>();
            return new SeekPreviewBatchService(seekPreview, logger);
        });
        serviceCollection.AddHostedService(sp => sp.GetRequiredService<SeekPreviewBatchService>());

        // 播放进度事件：实时更新 seek-preview 优先级中心（/Sessions/Playing/Progress 触发）
        serviceCollection.AddTransient<IEventConsumer<PlaybackProgressEventArgs>, SeekPreviewProgressConsumer>();

        // FontAcquisitionService: 先注册为 Singleton（供 Controller/JobService 注入），
        // 再用同一实例注册为 IHostedService（触发 StartAsync/StopAsync 生命周期）
        serviceCollection.AddSingleton<FontAcquisitionService>(sp =>
        {
            var appPaths = applicationHost.Resolve<MediaBrowser.Common.Configuration.IApplicationPaths>();
            var logger = sp.GetRequiredService<Microsoft.Extensions.Logging.ILogger<FontAcquisitionService>>();
            return new FontAcquisitionService(appPaths, logger);
        });
        serviceCollection.AddHostedService(sp => sp.GetRequiredService<FontAcquisitionService>());

        // PosterSheetJobService: 同上模式
        serviceCollection.AddSingleton<PosterSheetJobService>(sp =>
        {
            var appPaths = applicationHost.Resolve<MediaBrowser.Common.Configuration.IApplicationPaths>();
            var logger = sp.GetRequiredService<Microsoft.Extensions.Logging.ILogger<PosterSheetJobService>>();
            var fontSvc = sp.GetRequiredService<FontAcquisitionService>();
            return new PosterSheetJobService(appPaths, logger, fontSvc);
        });

        // FrameExportService: 单例，管理 frame-forge Rust daemon 进程和 Unix socket 连接
        serviceCollection.AddSingleton<FrameExportService>(sp =>
        {
            var appPaths = applicationHost.Resolve<MediaBrowser.Common.Configuration.IApplicationPaths>();
            var logger = sp.GetRequiredService<ILogger<FrameExportService>>();
            return new FrameExportService(appPaths, logger);
        });

        // FrameExportTaskManager: 单例，管理生成任务生命周期 + 定时清理
        serviceCollection.AddSingleton<FrameExportTaskManager>(sp =>
        {
            var logger = sp.GetRequiredService<ILogger<FrameExportTaskManager>>();
            var appPaths = applicationHost.Resolve<MediaBrowser.Common.Configuration.IApplicationPaths>();
            return new FrameExportTaskManager(logger, appPaths);
        });
        serviceCollection.AddSingleton<UserSettingsService>(sp =>
        {
            var appPaths = applicationHost.Resolve<MediaBrowser.Common.Configuration.IApplicationPaths>();
            return new UserSettingsService(appPaths);
        });

        // 注入 IHttpContextAccessor 供 i18n 读取浏览器语言
        serviceCollection.AddHttpContextAccessor();
        serviceCollection.AddSingleton<IStartupFilter, TaskStringsInitializer>();
    }
}

/// <summary>
/// 在应用启动后设置 TaskStrings 的 HttpContext 访问器。
/// </summary>
internal class TaskStringsInitializer : IStartupFilter
{
    private readonly IHttpContextAccessor _accessor;
    public TaskStringsInitializer(IHttpContextAccessor accessor) => _accessor = accessor;
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
    {
        TaskStrings.SetHttpAccessor(_accessor);
        next(app);
    };
}

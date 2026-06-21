using System.Reflection;
using Jellyfin.Plugin.JellyfinSuite.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.JellyfinSuite;

/// <summary>
/// Jellyfin Suite plugin — recently played view, poster sheet generator, and web player enhancer.
/// IMPORTANT: This GUID must never change after first release.
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    public static readonly Guid StaticId = new("a6dd5650-d124-42b6-806a-5426f266e8f2");

    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    public static Plugin? Instance { get; private set; }

    public override string Name => PluginConstants.PluginName;

    public override Guid Id => StaticId;

    public override string Description =>
        "A Jellyfin plugin suite: recently played view, poster sheet generator, and web player enhancer.";

    public IEnumerable<PluginPageInfo> GetPages()
    {
        var prefix = GetType().Assembly.GetName().Name + ".Web.";
        return
        [
            new PluginPageInfo
            {
                Name = "JellyfinSuite",
                EmbeddedResourcePath = prefix + "config.html",
                EnableInMainMenu = true,
                DisplayName = "最近播放",
                MenuSection = "user",
                MenuIcon = "schedule",
            },
            new PluginPageInfo
            {
                Name = "JellyfinSuiteBundle",
                EmbeddedResourcePath = prefix + "jellyfin-suite.js",
            },
            new PluginPageInfo
            {
                Name = "JellyfinSuitePlayerEnhancer",
                EmbeddedResourcePath = prefix + "jellyfin-suite-enhancer.js",
            }
        ];
    }
}

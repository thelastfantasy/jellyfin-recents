using System.Xml.Serialization;
using Jellyfin.Plugin.JellyfinSuite.Configuration;
using Xunit;

namespace JellyfinSuite.Tests;

/// <summary>
/// Tests for the hardware-decode settings (spec 013): the PUT validation rule (mirrors
/// FrameExportController.SetHwDecodeSettings's exact degrade-don't-reject logic) and the
/// persistence round-trip that backs FR-007 ("settings survive a restart" — exercised here via a
/// real XmlSerializer round-trip rather than booting a full Jellyfin plugin host, the same
/// "mirror the server-side logic in a pure, testable form" approach
/// PosterSheetControllerValidationTests uses for its own controller).
/// </summary>
public class HwDecodeSettingsTests
{
    // Mirror of FrameExportController.SetHwDecodeSettings's exact validation expression.
    private static string NormalizeDeviceStrategy(string? value) =>
        value is "performance" or "idle-resource" ? value : "performance";

    [Theory]
    [InlineData("performance", "performance")]
    [InlineData("idle-resource", "idle-resource")]
    public void NormalizeDeviceStrategy_AcceptsKnownValues(string input, string expected)
    {
        Assert.Equal(expected, NormalizeDeviceStrategy(input));
    }

    [Theory]
    [InlineData("")]
    [InlineData("bogus")]
    [InlineData("Performance")] // case-sensitive: not a silent alias of "performance"
    [InlineData(null)]
    public void NormalizeDeviceStrategy_DegradesUnknownValuesToPerformance(string? input)
    {
        Assert.Equal("performance", NormalizeDeviceStrategy(input));
    }

    [Fact]
    public void PluginConfiguration_HwDecodeDefaults()
    {
        var config = new PluginConfiguration();
        Assert.True(config.HwDecodeEnabled);
        Assert.Equal("performance", config.HwDecodeDeviceStrategy);
    }

    [Fact]
    public void PluginConfiguration_HwDecodeSettings_SurviveXmlRoundTrip()
    {
        var original = new PluginConfiguration
        {
            HwDecodeEnabled = false,
            HwDecodeDeviceStrategy = "idle-resource",
        };

        var serializer = new XmlSerializer(typeof(PluginConfiguration));
        using var stream = new MemoryStream();
        serializer.Serialize(stream, original);
        stream.Position = 0;
        var roundTripped = (PluginConfiguration)serializer.Deserialize(stream)!;

        Assert.Equal(original.HwDecodeEnabled, roundTripped.HwDecodeEnabled);
        Assert.Equal(original.HwDecodeDeviceStrategy, roundTripped.HwDecodeDeviceStrategy);
    }
}

namespace Jellyfin.Plugin.JellyfinSuite.Services;

/// <summary>Reads width/height from raw file headers without a full imaging library
/// (the plugin has no ImageSharp/System.Drawing dependency). Only needs to cover the
/// three container formats frame-forge ever produces: PNG (static), GIF (animation),
/// WebP (animation, always via AnimationEncoder → VP8X container).</summary>
internal static class ImageDimensionReader
{
    public static (int Width, int Height)? TryRead(string path)
    {
        try
        {
            using var stream = File.OpenRead(path);
            Span<byte> header = stackalloc byte[32];
            var read = stream.Read(header);
            if (read < 30) return null;

            // PNG: 8-byte signature, then IHDR chunk: width/height as big-endian uint32 at offset 16/20.
            if (header[0] == 0x89 && header[1] == 0x50 && header[2] == 0x4E && header[3] == 0x47)
            {
                var width = ReadUInt32BigEndian(header[16..20]);
                var height = ReadUInt32BigEndian(header[20..24]);
                return ((int)width, (int)height);
            }

            // GIF: "GIF87a"/"GIF89a" signature, then width/height as little-endian uint16 at offset 6/8.
            if (header[0] == 'G' && header[1] == 'I' && header[2] == 'F')
            {
                var width = ReadUInt16LittleEndian(header[6..8]);
                var height = ReadUInt16LittleEndian(header[8..10]);
                return (width, height);
            }

            // WebP: "RIFF" + size(4) + "WEBP" + fourCC(4). Only VP8X (extended, used by
            // AnimationEncoder for all animated output) carries canvas dimensions we know how
            // to read; bare VP8/VP8L single-frame containers are never produced by this project.
            if (header[0] == 'R' && header[1] == 'I' && header[2] == 'F' && header[3] == 'F'
                && header[8] == 'W' && header[9] == 'E' && header[10] == 'B' && header[11] == 'P'
                && header[12] == 'V' && header[13] == 'P' && header[14] == '8' && header[15] == 'X')
            {
                // VP8X chunk payload starts at offset 20: 4 bytes flags/reserved, then
                // 24-bit little-endian (canvasWidth-1) and (canvasHeight-1).
                var width = (header[24] | (header[25] << 8) | (header[26] << 16)) + 1;
                var height = (header[27] | (header[28] << 8) | (header[29] << 16)) + 1;
                return (width, height);
            }

            return null;
        }
        catch
        {
            return null;
        }
    }

    private static uint ReadUInt32BigEndian(Span<byte> b) =>
        ((uint)b[0] << 24) | ((uint)b[1] << 16) | ((uint)b[2] << 8) | b[3];

    private static int ReadUInt16LittleEndian(Span<byte> b) => b[0] | (b[1] << 8);
}

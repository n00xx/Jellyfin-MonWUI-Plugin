using System;
using System.Collections.Generic;
using System.IO;

namespace Jellyfin.Plugin.JMSFusion
{
    internal static class EmbeddedAssetHelper
    {
        /// <summary>
        /// Embedded resource names indexed by every dot-segment-aligned suffix of each name.
        /// </summary>
        /// <remarks>
        /// Built once. The previous lookup called <c>GetManifestResourceNames()</c> and scanned
        /// it with <c>EndsWith</c> on every call — an array allocation plus a linear walk over
        /// every embedded resource in the assembly, of which there are several hundred.
        /// <para>
        /// Keying on segment-aligned suffixes also tightens matching: plain <c>EndsWith</c>
        /// treats the name as an opaque string, so a lookup for <c>settings.css</c> would match
        /// a resource called <c>player-settings.css</c>. Here a suffix only matches where it
        /// begins immediately after a dot, so it can only ever match a whole path segment.
        /// </para>
        /// </remarks>
        private static readonly Lazy<IReadOnlyDictionary<string, string>> ResourceIndex =
            new(BuildResourceIndex, isThreadSafe: true);

        private static IReadOnlyDictionary<string, string> BuildResourceIndex()
        {
            var assembly = typeof(JMSFusionPlugin).Assembly;
            var index = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

            foreach (var name in assembly.GetManifestResourceNames())
            {
                // Resource names are the root namespace followed by the path, dot-separated.
                // Index each suffix beginning at a segment boundary so callers can ask by
                // whichever portion of the path they know.
                for (var i = 0; i < name.Length; i++)
                {
                    if (i != 0 && name[i - 1] != '.') continue;

                    // First writer wins, matching the previous FirstOrDefault() behaviour.
                    index.TryAdd(name[i..], name);
                }
            }

            return index;
        }

        private static bool TryResolve(string resourceName, out string manifestName)
        {
            manifestName = string.Empty;

            return !string.IsNullOrWhiteSpace(resourceName)
                   && ResourceIndex.Value.TryGetValue(resourceName.TrimStart('.'), out manifestName!);
        }

        internal static bool Exists(string resourceName) => TryResolve(resourceName, out _);

        internal static byte[]? TryRead(string resourceName)
        {
            if (!TryResolve(resourceName, out var manifestName)) return null;

            using var stream = typeof(JMSFusionPlugin).Assembly.GetManifestResourceStream(manifestName);
            if (stream == null) return null;

            using var buffer = new MemoryStream();
            stream.CopyTo(buffer);
            return buffer.ToArray();
        }
    }
}

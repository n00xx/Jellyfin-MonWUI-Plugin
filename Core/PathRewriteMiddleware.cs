using System;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;

namespace Jellyfin.Plugin.JMSFusion.Core
{
    /// <summary>
    /// Normalises incoming slider asset paths to the single internal form <c>/slider/...</c>,
    /// which is what the static file providers and <c>SliderAssetsController</c> are mounted on.
    /// </summary>
    /// <remarks>
    /// Accepts both the <c>/web</c>-prefixed form the browser requests and the versioned
    /// <c>slider~v-{version}</c> segment emitted into index.html. Requests arriving through the
    /// versioned form are flagged so <c>AssetVersioning</c> can serve them as immutable.
    /// </remarks>
    public sealed class PathRewriteMiddleware
    {
        private const string WebPrefix = "/web";
        private const string SliderSegment = "/slider";

        private readonly RequestDelegate _next;

        public PathRewriteMiddleware(RequestDelegate next) => _next = next;

        public async Task InvokeAsync(HttpContext ctx)
        {
            if (ctx.Request.Path.HasValue
                && TryNormalize(ctx.Request.Path.Value!, out var normalized, out var versioned))
            {
                ctx.Request.Path = new PathString(normalized);

                if (versioned)
                {
                    ctx.Items[AssetVersioning.VersionedRequestItemKey] = true;
                }
            }

            await _next(ctx);
        }

        /// <summary>
        /// Maps any of <c>/slider/x</c>, <c>/web/slider/x</c>, <c>/slider~v-N/x</c> and
        /// <c>/web/slider~v-N/x</c> onto <c>/slider/x</c>.
        /// </summary>
        /// <remarks>
        /// Any version token is accepted, not only the current one: a client that started a
        /// session against the previous build must still be served rather than 404'd mid-page.
        /// Freshness is enforced by the cache headers, which only go immutable when the token
        /// matches the running assembly.
        /// </remarks>
        internal static bool TryNormalize(string path, out string normalized, out bool versioned)
        {
            normalized = path;
            versioned = false;

            var body = path;
            if (body.StartsWith(WebPrefix + "/", StringComparison.OrdinalIgnoreCase))
            {
                body = body[WebPrefix.Length..];
            }

            if (!body.StartsWith(SliderSegment, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            var rest = body[SliderSegment.Length..];

            // "/slider" exactly, or "/slider/..." — already the internal form.
            if (rest.Length == 0 || rest[0] == '/')
            {
                normalized = body;
                return !string.Equals(body, path, StringComparison.Ordinal);
            }

            if (!rest.StartsWith(AssetVersioning.VersionMarker, StringComparison.Ordinal))
            {
                return false;
            }

            versioned = true;
            var slash = rest.IndexOf('/', StringComparison.Ordinal);
            normalized = slash < 0 ? SliderSegment : SliderSegment + rest[slash..];
            return true;
        }
    }
}

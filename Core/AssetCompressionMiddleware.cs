using System;
using System.Collections.Concurrent;
using System.IO;
using System.IO.Compression;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.Net.Http.Headers;

namespace Jellyfin.Plugin.JMSFusion.Core
{
    /// <summary>
    /// Holds Brotli/Gzip encodings of the plugin's static text assets, keyed by encoding and path.
    /// </summary>
    /// <remarks>
    /// The plugin's static files are registered through <c>IStartupFilter</c>, which places them
    /// upstream of Jellyfin's own compression middleware — so without this they are served
    /// uncompressed. Caching the encoded bytes rather than deferring to the framework also means
    /// each asset is compressed at most once per encoding for the lifetime of the process: the
    /// files are embedded in the assembly and cannot change while it is loaded.
    /// </remarks>
    public sealed class AssetCompressionCache
    {
        /// <summary>Below this size, header and framing overhead outweighs the saving.</summary>
        private const int MinimumSizeBytes = 1024;

        /// <summary>
        /// Bounds the cache in case a deployment points <c>ScriptDirectory</c> at a large tree.
        /// </summary>
        private const int MaxEntries = 2048;

        private readonly ConcurrentDictionary<string, byte[]> _entries = new(StringComparer.Ordinal);

        public bool TryGet(string key, out byte[]? payload) => _entries.TryGetValue(key, out payload);

        public void Store(string key, byte[] payload)
        {
            if (_entries.Count >= MaxEntries)
            {
                return;
            }

            _entries[key] = payload;
        }

        public static bool IsWorthCompressing(long length) => length >= MinimumSizeBytes;

        public static byte[] Compress(byte[] source, string encoding)
        {
            using var output = new MemoryStream();

            // Optimal rather than Fastest: this runs once per asset for the lifetime of the
            // process, so the extra time is repaid on every subsequent request.
            if (string.Equals(encoding, "br", StringComparison.Ordinal))
            {
                using (var brotli = new BrotliStream(output, CompressionLevel.Optimal, leaveOpen: true))
                {
                    brotli.Write(source, 0, source.Length);
                }
            }
            else
            {
                using (var gzip = new GZipStream(output, CompressionLevel.Optimal, leaveOpen: true))
                {
                    gzip.Write(source, 0, source.Length);
                }
            }

            return output.ToArray();
        }
    }

    /// <summary>
    /// Compresses the plugin's own static text assets, reusing cached encodings.
    /// </summary>
    public sealed class AssetCompressionMiddleware
    {
        private readonly RequestDelegate _next;
        private readonly AssetCompressionCache _cache;

        public AssetCompressionMiddleware(RequestDelegate next, AssetCompressionCache cache)
        {
            _next = next;
            _cache = cache;
        }

        public async Task InvokeAsync(HttpContext ctx)
        {
            var encoding = PickEncoding(ctx.Request.Headers[HeaderNames.AcceptEncoding].ToString());
            if (encoding is null || !HttpMethods.IsGet(ctx.Request.Method))
            {
                await _next(ctx);
                return;
            }

            var originalBody = ctx.Response.Body;
            using var buffer = new MemoryStream();
            ctx.Response.Body = buffer;

            try
            {
                await _next(ctx);
            }
            finally
            {
                ctx.Response.Body = originalBody;
            }

            // Anything that is not a complete, uncompressed, compressible 200 — notably the 304
            // that conditional requests short-circuit to — is passed through untouched.
            var eligible = !ctx.Response.HasStarted
                           && ctx.Response.StatusCode == StatusCodes.Status200OK
                           && !ctx.Response.Headers.ContainsKey(HeaderNames.ContentEncoding)
                           && IsCompressibleContentType(ctx.Response.ContentType)
                           && AssetCompressionCache.IsWorthCompressing(buffer.Length);

            if (!eligible)
            {
                await CopyThroughAsync(ctx, buffer, originalBody);
                return;
            }

            var cacheKey = $"{encoding}:{ctx.Request.Path.Value}";
            if (!_cache.TryGet(cacheKey, out var payload) || payload is null)
            {
                var raw = buffer.ToArray();
                payload = AssetCompressionCache.Compress(raw, encoding);

                // A pathological asset can encode larger than the original; never ship that.
                if (payload.Length >= raw.Length)
                {
                    await CopyThroughAsync(ctx, buffer, originalBody);
                    return;
                }

                _cache.Store(cacheKey, payload);
            }

            ctx.Response.Headers[HeaderNames.ContentEncoding] = encoding;
            ctx.Response.Headers.Append(HeaderNames.Vary, HeaderNames.AcceptEncoding);
            ctx.Response.ContentLength = payload.Length;

            await originalBody.WriteAsync(payload, 0, payload.Length, ctx.RequestAborted);
        }

        private static async Task CopyThroughAsync(HttpContext ctx, MemoryStream buffer, Stream originalBody)
        {
            if (buffer.Length == 0)
            {
                return;
            }

            if (!ctx.Response.HasStarted)
            {
                ctx.Response.ContentLength = buffer.Length;
            }

            buffer.Position = 0;
            await buffer.CopyToAsync(originalBody, ctx.RequestAborted);
        }

        /// <summary>
        /// Brotli is preferred where offered; it is meaningfully smaller than gzip on JavaScript.
        /// </summary>
        private static string? PickEncoding(string acceptEncoding)
        {
            if (string.IsNullOrEmpty(acceptEncoding))
            {
                return null;
            }

            if (acceptEncoding.Contains("br", StringComparison.OrdinalIgnoreCase))
            {
                return "br";
            }

            if (acceptEncoding.Contains("gzip", StringComparison.OrdinalIgnoreCase))
            {
                return "gzip";
            }

            return null;
        }

        private static bool IsCompressibleContentType(string? contentType)
        {
            if (string.IsNullOrEmpty(contentType))
            {
                return false;
            }

            return contentType.StartsWith("application/javascript", StringComparison.OrdinalIgnoreCase)
                || contentType.StartsWith("text/javascript", StringComparison.OrdinalIgnoreCase)
                || contentType.StartsWith("text/css", StringComparison.OrdinalIgnoreCase)
                || contentType.StartsWith("application/json", StringComparison.OrdinalIgnoreCase)
                || contentType.StartsWith("image/svg+xml", StringComparison.OrdinalIgnoreCase)
                || contentType.StartsWith("text/plain", StringComparison.OrdinalIgnoreCase);
        }
    }
}

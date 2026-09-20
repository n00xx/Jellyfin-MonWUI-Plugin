using System;
using System.Globalization;

namespace Jellyfin.Plugin.JMSFusion.Core;

/// <summary>
/// Builds the credential Jellyfin still accepts for server-to-server calls.
/// Jellyfin 12 dropped the legacy <c>X-Emby-Token</c> header and the <c>?api_key=</c>
/// query parameter: both now answer 401, and only
/// <c>Authorization: MediaBrowser Token="..."</c> authenticates.
/// </summary>
public static class JellyfinAuth
{
    /// <summary>Header name carrying the credential.</summary>
    public const string HeaderName = "Authorization";

    private static readonly string ClientVersion =
        typeof(JellyfinAuth).Assembly.GetName().Version?.ToString() ?? "1.0.0";

    /// <summary>
    /// Formats <paramref name="apiKey"/> as a MediaBrowser authorization header value.
    /// </summary>
    public static string BuildHeaderValue(string? apiKey)
    {
        var token = (apiKey ?? string.Empty).Replace("\"", string.Empty, StringComparison.Ordinal);
        return string.Format(
            CultureInfo.InvariantCulture,
            "MediaBrowser Client=\"JMSFusion\", Device=\"Server\", DeviceId=\"jmsfusion-server\", Version=\"{0}\", Token=\"{1}\"",
            ClientVersion,
            token);
    }

    /// <summary>
    /// Reads the caller's credential from an incoming request, accepting the modern
    /// <c>Authorization</c> header first and falling back to the legacy
    /// <c>X-Emby-Token</c> so clients on older servers keep working.
    /// </summary>
    public static string? ReadIncomingToken(Microsoft.AspNetCore.Http.IHeaderDictionary headers)
    {
        if (headers is null)
        {
            return null;
        }

        // Authorization is primary: it is the only credential Jellyfin 12 itself reads, and
        // the plugin's own clients send it alongside the legacy header. X-Emby-Token stays as
        // a fallback so clients talking to a 10.11 server keep authenticating here.
        var auth = headers[HeaderName].ToString();
        if (!string.IsNullOrWhiteSpace(auth))
        {
            // MediaBrowser Client="Jellyfin Web Client", Device="..", Token="abc"
            var match = System.Text.RegularExpressions.Regex.Match(
                auth,
                "Token\\s*=\\s*\"?([^\",\\s]+)\"?",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase);

            if (match.Success)
            {
                return match.Groups[1].Value;
            }
        }

        var legacy = headers["X-Emby-Token"].ToString();
        return string.IsNullOrWhiteSpace(legacy) ? null : legacy.Trim();
    }
}

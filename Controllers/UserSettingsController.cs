using MediaBrowser.Common.Api;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using System.Text.Json;
using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.JMSFusion.Controllers
{
    [ApiController]
    [Route("Plugins/JMSFusion/UserSettings")]
    public class UserSettingsController : ControllerBase
    {
        private void NoCache()
        {
            Response.Headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0";
            Response.Headers["Pragma"] = "no-cache";
            Response.Headers["Expires"] = "0";
        }

        private static string NormalizeProfile(string? p)
        {
            p = (p ?? "").Trim().ToLowerInvariant();
            return (p == "mobile" || p == "m") ? "mobile" : "desktop";
        }

        private static readonly HashSet<string> DeniedSnapshotKeys = new(StringComparer.OrdinalIgnoreCase)
        {
            "json-credentials",
            "api-key",
            "accessToken",
            "serverId",
            "userId",
            "deviceId",
            // jellyfin-web's real DeviceId key. Shared, it makes every browser one device to
            // Jellyfin, and a login on any of them revokes that user's token on all the others.
            "_deviceId2",
            "sessionId",
            "jf_serverAddress",
            "jf_userId",
            "jf_api_deviceId",
            "jf_api_deviceName",
            "persist_user_id",
            "persist_device_id",
            "persist_device_name",
            "persist_server_id",
            "serverAddress",
            "currentUserIsAdmin",
            "currentUserId",
            "currentUserName",
            "emby.device.id",
            "emby.session.id",
            "jellyfin_credentials",
            "emby_credentials",
            "jf_debug_api",
            "jms:lastPlayNowDebug",
            "jms_backdrop_index",
            "userTopGenresCache",
            "userTopGenres_v2"
        };

        private static readonly string[] DeniedSnapshotPrefixes =
        {
            "persist_",
            "jf:",
            "emby.",
            "jms:debug:",
            "jms:trace:",
            "jms:focusedUserDataSync:",
            "jms:last",
            "jms_indexer_",
            "studioHub_",
            "avatar-"
        };

        // A key that names a user, server or library id is data one browser holds about one
        // instance, never a shared UI setting: user-<userId>-<serverId> (a user's record),
        // <userId>-homesection0, kefinTweaks_watchlist_movies_<userId>... "Publish global" dumps
        // all of localStorage, so these reached the blob and Get served them to anyone.
        private static readonly Regex InstanceIdInKey = new(
            "(?<![0-9a-f])(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?![0-9a-f])",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant | RegexOptions.Compiled);

        private static bool ShouldPersistSnapshotKey(string? key)
        {
            var normalized = (key ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(normalized)) return false;
            if (DeniedSnapshotKeys.Contains(normalized)) return false;
            if (InstanceIdInKey.IsMatch(normalized)) return false;

            foreach (var prefix in DeniedSnapshotPrefixes)
            {
                if (normalized.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                {
                    return false;
                }
            }

            return !normalized.Contains("token", StringComparison.OrdinalIgnoreCase)
                && !normalized.Contains("credential", StringComparison.OrdinalIgnoreCase)
                && !normalized.Contains("session", StringComparison.OrdinalIgnoreCase);
        }

        private static string SerializeSanitizedSnapshot(JsonElement element)
        {
            if (element.ValueKind != JsonValueKind.Object)
            {
                return "{}";
            }

            var filtered = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
            foreach (var prop in element.EnumerateObject())
            {
                if (!ShouldPersistSnapshotKey(prop.Name)) continue;
                filtered[prop.Name] = prop.Value.Clone();
            }

            return JsonSerializer.Serialize(filtered);
        }

        private static string SanitizeSnapshotJson(string? json)
        {
            if (string.IsNullOrWhiteSpace(json))
            {
                return "{}";
            }

            try
            {
                using var doc = JsonDocument.Parse(json);
                return SerializeSanitizedSnapshot(doc.RootElement);
            }
            catch
            {
                return "{}";
            }
        }

        private static string SerializeSanitizedSnapshot(object? snapshot)
        {
            if (snapshot is JsonElement element)
            {
                return SerializeSanitizedSnapshot(element);
            }

            if (snapshot is null)
            {
                return "{}";
            }

            try
            {
                return SanitizeSnapshotJson(JsonSerializer.Serialize(snapshot));
            }
            catch
            {
                return "{}";
            }
        }

        private static void EnsureMigrated(JMSFusionConfiguration cfg, JMSFusionPlugin plugin)
        {
            var legacy = cfg.GlobalUserSettingsJson;
            var legacyHas = !string.IsNullOrWhiteSpace(legacy) && legacy != "{}";

            var desktopEmpty = string.IsNullOrWhiteSpace(cfg.GlobalUserSettingsJsonDesktop) || cfg.GlobalUserSettingsJsonDesktop == "{}";
            var mobileEmpty  = string.IsNullOrWhiteSpace(cfg.GlobalUserSettingsJsonMobile)  || cfg.GlobalUserSettingsJsonMobile  == "{}";

            if (!legacyHas) return;
            if (!(desktopEmpty && mobileEmpty)) return;

            cfg.GlobalUserSettingsJsonDesktop = legacy!;
            cfg.GlobalUserSettingsJsonMobile  = legacy!;

            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            cfg.GlobalUserSettingsRevisionDesktop = now;
            cfg.GlobalUserSettingsRevisionMobile  = now;

            plugin.UpdateConfiguration(cfg);
        }

        // Anonymous on purpose: the blob is UI settings only (sanitized above), and the login
        // page and boot splash read it before anyone has signed in.
        [HttpGet]
        public IActionResult Get([FromQuery] string? profile = null)
        {
            var plugin = JMSFusionPlugin.Instance;
            var cfg = plugin.Configuration;

            EnsureMigrated(cfg, plugin);

            var prof = NormalizeProfile(profile);
            var json = prof == "mobile"
                ? (cfg.GlobalUserSettingsJsonMobile ?? "{}")
                : (cfg.GlobalUserSettingsJsonDesktop ?? "{}");
            var sanitizedJson = SanitizeSnapshotJson(json);
            var rev = prof == "mobile"
                ? cfg.GlobalUserSettingsRevisionMobile
                : cfg.GlobalUserSettingsRevisionDesktop;

            object globalObj;
            try
            {
                globalObj = JsonSerializer.Deserialize<object>(sanitizedJson) ?? new();
            }
            catch
            {
                globalObj = new();
            }

            NoCache();
            return Ok(new
            {
                profile = prof,
                rev,
                forceGlobal = cfg.ForceGlobalUserSettings,
                global = globalObj
            });
        }

        public sealed class PublishReq
        {
            public object? Global { get; set; }
            public string? Profile { get; set; }
        }

        // Every browser applies this blob over its own localStorage, so whoever writes it sets
        // the UI for all users. It used to accept anonymous writes.
        [HttpPost("Publish")]
        [Authorize(Policy = Policies.RequiresElevation)]
        public IActionResult Publish([FromBody] PublishReq req, [FromQuery] string? profile = null)
        {
            var plugin = JMSFusionPlugin.Instance;
            var cfg = plugin.Configuration;

            EnsureMigrated(cfg, plugin);

            var prof = NormalizeProfile(req.Profile ?? profile);
            var json = SerializeSanitizedSnapshot(req.Global);
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

            if (prof == "mobile")
            {
                if (string.Equals(cfg.GlobalUserSettingsJsonMobile ?? "{}", json, StringComparison.Ordinal))
                {
                    NoCache();
                    return Ok(new { ok = true, profile = prof, rev = cfg.GlobalUserSettingsRevisionMobile, skipped = true });
                }

                cfg.GlobalUserSettingsJsonMobile = json;
                cfg.GlobalUserSettingsRevisionMobile = now;
            }
            else
            {
                if (string.Equals(cfg.GlobalUserSettingsJsonDesktop ?? "{}", json, StringComparison.Ordinal))
                {
                    NoCache();
                    return Ok(new { ok = true, profile = prof, rev = cfg.GlobalUserSettingsRevisionDesktop, skipped = true });
                }

                cfg.GlobalUserSettingsJsonDesktop = json;
                cfg.GlobalUserSettingsRevisionDesktop = now;
            }

            plugin.UpdateConfiguration(cfg);

            NoCache();
            return Ok(new { ok = true, profile = prof, rev = now });
        }
    }
}

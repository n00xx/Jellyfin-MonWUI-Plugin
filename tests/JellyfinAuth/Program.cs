using System;
using System.IO;
using System.Reflection;
using Microsoft.AspNetCore.Http;

// Verifies the server-side half of the Jellyfin 12 auth change against the *built* plugin.
//
// Jellyfin 12 answers 401 to X-Emby-Token and ?api_key= and only reads
// `Authorization: MediaBrowser Token="..."`. Two things therefore have to hold:
//
//   1. BuildHeaderValue() emits a credential that server sends on its own outbound calls
//      (TrailerAutomationService, the lyrics library scan). Measured against a live 12.1
//      server, the emitted shape returns 200 on /System/Info and /Users/{id}/Items.
//   2. ReadIncomingToken() pulls the caller's token out of an inbound request, preferring
//      Authorization and falling back to X-Emby-Token so clients on 10.11 still work.
//
// (2) is the fiddly one: the header is comma-separated and Client="Jellyfin Web Client"
// contains a space, so a lazy regex truncates the token or grabs the wrong field.

internal static class Program
{
    private static int _failures;

    private static void Ok(string msg) => Console.WriteLine("  ok   " + msg);

    private static void Fail(string msg)
    {
        _failures++;
        Console.WriteLine("  FAIL " + msg);
    }

    private static void Expect(string actual, string expected, string what)
    {
        if (string.Equals(actual, expected, StringComparison.Ordinal))
        {
            Ok($"{what} -> {actual ?? "(null)"}");
        }
        else
        {
            Fail($"{what}: expected {expected ?? "(null)"}, got {actual ?? "(null)"}");
        }
    }

    public static int Main()
    {
        var dll = Path.Combine(
            AppContext.BaseDirectory, "..", "..", "..", "..", "..",
            "bin", "Release", "net10.0", "Jellyfin.Plugin.JMSFusion.dll");

        var type = Assembly.LoadFrom(Path.GetFullPath(dll))
            .GetType("Jellyfin.Plugin.JMSFusion.Core.JellyfinAuth", throwOnError: true);

        var build = type.GetMethod("BuildHeaderValue", BindingFlags.Public | BindingFlags.Static);
        var read = type.GetMethod("ReadIncomingToken", BindingFlags.Public | BindingFlags.Static);

        // --- BuildHeaderValue -------------------------------------------------------------
        var header = (string)build.Invoke(null, new object[] { "abc123" });

        if (header.StartsWith("MediaBrowser ", StringComparison.Ordinal))
        {
            Ok("emits a MediaBrowser credential");
        }
        else
        {
            Fail("must emit a MediaBrowser credential, got: " + header);
        }

        if (header.Contains("Token=\"abc123\"", StringComparison.Ordinal))
        {
            Ok("carries the token in the Token field");
        }
        else
        {
            Fail("must carry Token=\"abc123\", got: " + header);
        }

        // A quote in the key would close the value early and corrupt the whole credential.
        var dirty = (string)build.Invoke(null, new object[] { "ab\"c" });
        if (!dirty.Contains("ab\"c", StringComparison.Ordinal) && dirty.Contains("Token=\"abc\"", StringComparison.Ordinal))
        {
            Ok("strips quotes out of the token");
        }
        else
        {
            Fail("quotes in the token must be stripped, got: " + dirty);
        }

        // --- ReadIncomingToken ------------------------------------------------------------
        // The exact string the browser-side authHeaders() sends.
        var browser = new HeaderDictionary
        {
            ["Authorization"] =
                "MediaBrowser Client=\"Jellyfin Web Client\", Device=\"Living Room TV\", " +
                "DeviceId=\"abc123\", Version=\"10.9.11\", Token=\"tok123\"",
            ["X-Emby-Token"] = "tok123",
        };
        Expect((string)read.Invoke(null, new object[] { browser }), "tok123",
            "reads the token out of a full browser Authorization header");

        // Authorization must win, so the documented contract and the code agree.
        var conflicting = new HeaderDictionary
        {
            ["Authorization"] = "MediaBrowser Client=\"x\", Token=\"fromAuth\"",
            ["X-Emby-Token"] = "fromLegacy",
        };
        Expect((string)read.Invoke(null, new object[] { conflicting }), "fromAuth",
            "prefers Authorization over the legacy header");

        // A 10.11-era client that only sends the legacy header must still authenticate.
        var legacyOnly = new HeaderDictionary { ["X-Emby-Token"] = "  legacyTok  " };
        Expect((string)read.Invoke(null, new object[] { legacyOnly }), "legacyTok",
            "falls back to X-Emby-Token and trims it");

        // An Authorization with no Token= field must not swallow the legacy fallback.
        var tokenless = new HeaderDictionary
        {
            ["Authorization"] = "MediaBrowser Client=\"x\", Device=\"y\"",
            ["X-Emby-Token"] = "legacyTok",
        };
        Expect((string)read.Invoke(null, new object[] { tokenless }), "legacyTok",
            "falls back when Authorization carries no Token field");

        Expect((string)read.Invoke(null, new object[] { new HeaderDictionary() }), null,
            "returns null when no credential is present");

        Console.WriteLine(_failures == 0 ? "\nPASS JellyfinAuth" : $"\nFAIL JellyfinAuth ({_failures})");
        return _failures == 0 ? 0 : 1;
    }
}

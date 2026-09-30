using System;
using System.IO;
using System.Reflection;
using System.Text.Json;

// Verifies UserSettingsController's snapshot filter against the *built* plugin assembly.
//
// The same filter runs on both sides of /Plugins/JMSFusion/UserSettings: Get() sanitizes the
// stored blob before serving it and Publish() sanitizes what a browser sends. So a key on the
// deny list is dropped even if an old blob still contains it, and even if a tab that loaded
// before the fix keeps publishing it.
//
// `_deviceId2` is jellyfin-web's DeviceId. Letting it through made every browser adopt one
// shared id, and Jellyfin revokes a user's previous token on the same DeviceId at login.
//
// Run with:  dotnet build -c Release && dotnet run --project tests/SnapshotSanitization

var pluginDll = Path.GetFullPath(Path.Combine(
    AppContext.BaseDirectory, "..", "..", "..", "..", "..", "bin", "Release", "net10.0",
    "Jellyfin.Plugin.JMSFusion.dll"));

if (!File.Exists(pluginDll))
{
    Console.Error.WriteLine($"Plugin assembly not found at {pluginDll}.\nRun `dotnet build -c Release` first.");
    return 2;
}

// The plugin's static initialiser reads its own AssemblyName, which pulls in the Jellyfin
// reference assemblies. Resolve those out of the NuGet cache so the harness can run standalone.
var nuget = Path.Combine(
    Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".nuget", "packages");

AppDomain.CurrentDomain.AssemblyResolve += (_, e) =>
{
    var wanted = new AssemblyName(e.Name).Name + ".dll";
    if (!Directory.Exists(nuget)) return null;

    foreach (var package in Directory.GetDirectories(nuget))
    {
        foreach (var candidate in Directory.GetFiles(package, wanted, SearchOption.AllDirectories))
        {
            if (candidate.Contains("/net10.0/") || candidate.Contains("/net9.0/") || candidate.Contains("/net8.0/"))
            {
                try { return Assembly.LoadFrom(candidate); } catch { /* try the next match */ }
            }
        }
    }

    return null;
};

var asm = Assembly.LoadFrom(pluginDll);
var controller = asm.GetType("Jellyfin.Plugin.JMSFusion.Controllers.UserSettingsController")!;
var sanitizeMethod = controller.GetMethod(
    "SanitizeSnapshotJson", BindingFlags.NonPublic | BindingFlags.Static, new[] { typeof(string) })!;

string Sanitize(string json) => (string)sanitizeMethod.Invoke(null, new object[] { json })!;

var failures = 0;
void Ok(string msg) => Console.WriteLine("  ok   " + msg);
void Fail(string msg) { failures++; Console.WriteLine("  FAIL " + msg); }

Console.WriteLine("a stored or published snapshot never carries jellyfin-web's device id");
{
    var sanitized = JsonDocument.Parse(Sanitize(
        """{"_deviceId2":"shared-id","enableSlider":"true","deviceId":"legacy","showCast":"false"}"""))
        .RootElement;

    if (sanitized.TryGetProperty("_deviceId2", out _)) Fail("_deviceId2 survived sanitization");
    else Ok("_deviceId2 is dropped");

    if (sanitized.TryGetProperty("deviceId", out _)) Fail("the already-denied deviceId came back");
    else Ok("deviceId is still dropped");

    if (sanitized.TryGetProperty("enableSlider", out var slider) && slider.GetString() == "true"
        && sanitized.TryGetProperty("showCast", out var cast) && cast.GetString() == "false")
    {
        Ok("ordinary settings pass through unchanged");
    }
    else
    {
        Fail("ordinary settings were altered: " + sanitized.GetRawText());
    }
}

Console.WriteLine(failures == 0 ? "\nALL PASS" : $"\n{failures} FAILURE(S)");
return failures == 0 ? 0 : 1;

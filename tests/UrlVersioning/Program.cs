using System;
using System.IO;
using System.Reflection;

// Verifies the asset-URL versioning round-trip against the *built* plugin assembly:
//
//   1. index.html emits ../slider~v-{version}/main.js
//   2. the browser resolves that, and every relative import inside it, using ES module semantics
//   3. PathRewriteMiddleware maps each request back onto the real /slider/... file
//   4. version-pinned requests are flagged so they can be served immutable
//
// The load-bearing invariant is (5): the version lives in a *rename* of the `slider` segment,
// never an extra path segment, because 45 specifiers in the codebase climb out of the slider
// root to reach ../Plugins/JMSFusion/runtime/*. Changing the path depth silently breaks all of
// them, so those are asserted to resolve exactly where they did before versioning.
//
// Run with:  dotnet build -c Release && dotnet run --project tests/UrlVersioning

var pluginDll = Path.GetFullPath(Path.Combine(
    AppContext.BaseDirectory, "..", "..", "..", "..", "..", "bin", "Release", "net9.0",
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
            if (candidate.Contains("/net9.0/") || candidate.Contains("/net8.0/"))
            {
                try { return Assembly.LoadFrom(candidate); } catch { /* try the next match */ }
            }
        }
    }

    return null;
};

var asm = Assembly.LoadFrom(pluginDll);
var assetVersioning = asm.GetType("Jellyfin.Plugin.JMSFusion.AssetVersioning")!;
var pathRewrite = asm.GetType("Jellyfin.Plugin.JMSFusion.Core.PathRewriteMiddleware")!;

var applyMethod = assetVersioning.GetMethod("ApplyVersionedSegment", BindingFlags.Public | BindingFlags.Static)!;
var segmentProperty = assetVersioning.GetProperty("VersionedSegment", BindingFlags.Public | BindingFlags.Static)!;
var normalizeMethod = pathRewrite.GetMethod("TryNormalize", BindingFlags.NonPublic | BindingFlags.Static)!;

string Apply(string path) => (string)applyMethod.Invoke(null, new object[] { path })!;

(bool Matched, string Path, bool Versioned) Normalize(string path)
{
    var args = new object?[] { path, null, null };
    var matched = (bool)normalizeMethod.Invoke(null, args)!;
    return (matched, (string)args[1]!, (bool)args[2]!);
}

// Browser-accurate relative URL resolution.
string Resolve(string baseUrl, string specifier) =>
    new Uri(new Uri("http://host" + baseUrl), specifier).AbsolutePath;

var failures = 0;

void Check(string label, object got, object want)
{
    var ok = Equals(got, want);
    if (!ok) failures++;
    Console.WriteLine($"{(ok ? "PASS" : "FAIL")} {label}  got={got}{(ok ? "" : "  want=" + want)}");
}

var segment = (string)segmentProperty.GetValue(null)!;
Console.WriteLine($"VersionedSegment = {segment}");

var legacyEntry = Resolve("/web/index.html", "../slider/main.js");
var entry = Resolve("/web/index.html", Apply("../slider/main.js"));
Console.WriteLine($"\nentry before: {legacyEntry}\nentry after : {entry}\n");

Check("entry point is versioned", entry, "/" + segment + "/main.js");
Check("entry normalizes to real file", Normalize(entry).Path, "/slider/main.js");
Check("entry flagged immutable", Normalize(entry).Versioned, true);

var player = Resolve("/web/index.html", Apply("../slider/modules/player/main.js"));
Check("player normalizes", Normalize(player).Path, "/slider/modules/player/main.js");

// Relative imports inherit the version and still map back to the right file.
foreach (var relative in new[] { "./modules/timer.js", "./modules/player/ui/playerUI.js", "./language/eng.js" })
{
    var before = Resolve(legacyEntry, relative);
    var after = Resolve(entry, relative);
    Check($"versioned: {relative}", after, "/" + segment + before["/slider".Length..]);
    Check($"resolves back: {relative}", Normalize(after).Path, before);
    Check($"immutable: {relative}", Normalize(after).Versioned, true);
}

// Regression guard: specifiers that climb out of the slider root must land exactly where they
// did before, at every nesting depth that appears in the codebase.
var escapes = new[]
{
    ("main.js",                       "main.js",                         "../Plugins/JMSFusion/runtime/api.js"),
    ("modules/utils.js",              "./modules/utils.js",              "../../Plugins/JMSFusion/runtime/api.js"),
    ("modules/seerr/ui.js",           "./modules/seerr/ui.js",           "../../../Plugins/JMSFusion/runtime/api.js"),
    ("modules/player/ui/playerUI.js", "./modules/player/ui/playerUI.js", "../../../../Plugins/JMSFusion/runtime/api.js"),
};

foreach (var (label, importer, specifier) in escapes)
{
    var before = Resolve(Resolve(legacyEntry, importer), specifier);
    var after = Resolve(Resolve(entry, importer), specifier);
    Check($"escape unchanged from {label}", after, before);
    Check($"escape reaches runtime api from {label}", after, "/Plugins/JMSFusion/runtime/api.js");
}

// Legacy and edge forms.
Check("legacy /web/slider/x", Normalize("/web/slider/src/settings.css").Path, "/slider/src/settings.css");
Check("legacy not immutable", Normalize("/web/slider/src/settings.css").Versioned, false);
Check("internal /slider/x untouched", Normalize("/slider/main.js").Matched, false);
Check("stale version still served", Normalize("/slider~v-0.0.0.0-deadbeef/main.js").Path, "/slider/main.js");
Check("versioned under /web too", Normalize("/web/" + segment + "/main.js").Path, "/slider/main.js");
Check("unrelated path ignored", Normalize("/web/index.html").Matched, false);
Check("decoy /web/sliders ignored", Normalize("/web/sliders/x.js").Matched, false);
Check("decoy /slider-other ignored", Normalize("/slider-other/x.js").Matched, false);

Console.WriteLine(failures == 0 ? "\nALL CHECKS PASSED" : $"\n{failures} CHECK(S) FAILED");
return failures == 0 ? 0 : 1;

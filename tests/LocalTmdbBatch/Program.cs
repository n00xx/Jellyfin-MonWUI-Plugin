using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;

// Verifies the query parsing behind GET /local/tmdb?ids=... against the *built* plugin assembly.
//
// That endpoint exists so the Buscar overlay can cross-reference a whole page of Seerr results
// against the local library in one round trip instead of one request per title. Because the id
// list arrives straight off a URL, the parser is the only thing standing between a hand-built
// request and an unbounded sweep of library lookups — so the cap, the dedup, and the silent
// rejection of junk are all load-bearing, not cosmetic.
//
// Run with:  dotnet build -c Release && dotnet run --project tests/LocalTmdbBatch

var pluginDll = Path.GetFullPath(Path.Combine(
    AppContext.BaseDirectory, "..", "..", "..", "..", "..", "bin", "Release", "net9.0",
    "Jellyfin.Plugin.JMSFusion.dll"));

if (!File.Exists(pluginDll))
{
    Console.WriteLine($"FAIL  built plugin not found at {pluginDll}");
    Console.WriteLine("      run: dotnet build -c Release");
    return 1;
}

var asm = Assembly.LoadFrom(pluginDll);
var controller = asm.GetType("Jellyfin.Plugin.JMSFusion.Controllers.SerrController", throwOnError: true);

var parse = controller.GetMethod("ParseTmdbIdList", BindingFlags.NonPublic | BindingFlags.Static);
if (parse is null) { Console.WriteLine("FAIL  ParseTmdbIdList not found"); return 1; }

var maxBatchField = controller.GetField("MaxLocalTmdbBatch", BindingFlags.NonPublic | BindingFlags.Static);
var maxBatch = (int)maxBatchField.GetRawConstantValue();

var failures = 0;
void Check(string label, IEnumerable<int> actual, IEnumerable<int> expected)
{
    var a = actual?.ToList() ?? new List<int>();
    var e = expected.ToList();
    if (a.SequenceEqual(e)) { Console.WriteLine($"  ok   {label}"); return; }
    failures++;
    Console.WriteLine($"  FAIL {label}\n         expected [{string.Join(",", e)}]\n         got      [{string.Join(",", a)}]");
}
void CheckInt(string label, int actual, int expected)
{
    if (actual == expected) { Console.WriteLine($"  ok   {label}"); return; }
    failures++;
    Console.WriteLine($"  FAIL {label} — expected {expected}, got {actual}");
}

List<int> Parse(string raw) => ((IEnumerable<int>)parse.Invoke(null, new object[] { raw })).ToList();

Console.WriteLine("\nGET /local/tmdb?ids= — query parsing");

Check("plain list preserved in order", Parse("603,604,605"), new[] { 603, 604, 605 });
Check("whitespace around ids tolerated", Parse(" 603 , 604 "), new[] { 603, 604 });
Check("duplicates collapse, first position wins", Parse("603,604,603"), new[] { 603, 604 });
Check("non-numeric entries dropped silently", Parse("603,abc,604"), new[] { 603, 604 });
Check("zero and negatives dropped", Parse("0,-5,603"), new[] { 603 });
Check("empty segments dropped", Parse("603,,,604"), new[] { 603, 604 });
Check("null yields empty", Parse(null), Array.Empty<int>());
Check("empty string yields empty", Parse(""), Array.Empty<int>());
Check("whitespace-only yields empty", Parse("   "), Array.Empty<int>());
Check("all-junk yields empty", Parse("abc,,-1,0"), Array.Empty<int>());
Check("overflowing integers dropped, not wrapped", Parse("99999999999999,603"), new[] { 603 });

// The cap is the guard against a hand-built URL turning one request into an unbounded sweep.
var oversized = string.Join(",", Enumerable.Range(1, maxBatch + 50));
CheckInt($"batch capped at MaxLocalTmdbBatch ({maxBatch})", Parse(oversized).Count, maxBatch);
Check("cap keeps the earliest ids", Parse(oversized).Take(3), new[] { 1, 2, 3 });

// Dedup must not let repeats consume cap headroom — 200 copies of one id is still one lookup.
CheckInt("repeated id collapses to a single lookup",
    Parse(string.Join(",", Enumerable.Repeat(603, 200))).Count, 1);

Console.WriteLine(failures == 0 ? "\nAll local/tmdb batch tests passed.\n" : $"\n{failures} test(s) FAILED.\n");
return failures == 0 ? 0 : 1;

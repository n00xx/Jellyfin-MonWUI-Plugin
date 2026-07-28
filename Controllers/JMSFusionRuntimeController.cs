using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Text;

namespace Jellyfin.Plugin.JMSFusion.Controllers
{
    [ApiController]
    [Route("JMSFusion/runtime")]
    [Route("Plugins/JMSFusion/runtime")]
    public class JMSFusionRuntimeController : ControllerBase
    {
        private static readonly IReadOnlyDictionary<string, string> ScriptResourceMap =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                ["auth"] = "RuntimeModules.auth.js",
                ["api"] = "RuntimeModules.api.js",
                ["storage-preload"] = "RuntimeModules.storagePreload.js"
            };

        /// <summary>
        /// Rendered script bodies, keyed by script name. The sources are embedded in the assembly
        /// and the rewrite depends only on the assembly version, so both are fixed for the
        /// lifetime of the process and there is no reason to redo either per request.
        /// </summary>
        private static readonly ConcurrentDictionary<string, byte[]> RenderedScripts =
            new(StringComparer.OrdinalIgnoreCase);

        private readonly ILogger<JMSFusionRuntimeController> _logger;

        public JMSFusionRuntimeController(ILogger<JMSFusionRuntimeController> logger)
        {
            _logger = logger;
        }

        [HttpGet("{name}.js")]
        public IActionResult GetScript(string name)
        {
            if (!ScriptResourceMap.TryGetValue(name, out var resourceSuffix))
            {
                return NotFound();
            }

            try
            {
                if (AssetVersioning.TryHandleConditionalGet(HttpContext, $"runtime:{name}"))
                {
                    return StatusCode(304);
                }

                if (!RenderedScripts.TryGetValue(name, out var body))
                {
                    var asm = typeof(JMSFusionPlugin).Assembly;
                    var ns = typeof(JMSFusionPlugin).Namespace;
                    var resourceName = $"{ns}.{resourceSuffix}";

                    using var stream = asm.GetManifestResourceStream(resourceName);
                    if (stream == null)
                    {
                        _logger.LogWarning("Runtime script resource not found: {ResourceName}", resourceName);
                        return NotFound();
                    }

                    using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
                    var source = AssetVersioning.AlignRuntimeModuleSpecifiers(reader.ReadToEnd());

                    body = Encoding.UTF8.GetBytes(source);
                    RenderedScripts[name] = body;
                }

                return File(body, "application/javascript; charset=utf-8");
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to serve runtime script: {ScriptName}", name);
                return StatusCode(500, "Internal server error");
            }
        }
    }
}

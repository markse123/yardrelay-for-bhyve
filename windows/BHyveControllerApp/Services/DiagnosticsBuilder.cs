using System.Reflection;
using BHyveControllerApp.Models;

namespace BHyveControllerApp.Services;

public static class DiagnosticsBuilder
{
    public static string Build(
        DesktopPaths paths,
        DesktopSettings settings,
        DesktopSecrets secrets,
        NodeCheck node,
        ServerController server,
        AppLogger logger)
    {
        return string.Join(Environment.NewLine, new[]
        {
            "YardRelay diagnostics",
            $"Generated: {DateTimeOffset.UtcNow:O}",
            $"App version: {ProductVersion}",
            $"Node usable: {node.IsUsable}",
            $"Node path: {node.Path ?? "(not found)"}",
            $"Node version: {node.Version ?? "(unknown)"}",
            $"Server root: {paths.ServerRoot}",
            $"Host: {settings.Host}",
            $"Port: {settings.Port}",
            $"Data dir: {settings.DataDir}",
            $"Yard-run config path: {settings.YardRunConfigPath}",
            $"Write access mode: {settings.WriteAccessMode}",
            $"Orbit email configured: {!string.IsNullOrWhiteSpace(secrets.OrbitEmail)}",
            $"Orbit password configured: {!string.IsNullOrWhiteSpace(secrets.OrbitPassword)}",
            $"App token configured: {!string.IsNullOrWhiteSpace(secrets.AppToken)}",
            $"Managed server running: {server.IsManagedRunning}",
            "Recent log lines:",
            Redactor.ForLog(logger.ReadRecent()),
        });
    }

    private static string ProductVersion
    {
        get
        {
            var version = Assembly.GetEntryAssembly()?.GetName().Version;
            return version is null ? "unknown" : $"{version.Major}.{version.Minor}.{version.Build}";
        }
    }
}

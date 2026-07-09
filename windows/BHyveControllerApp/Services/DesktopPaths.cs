using System.Diagnostics.CodeAnalysis;
using System.Security;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace BHyveControllerApp.Services;

public sealed class DesktopPaths
{
    internal const string StartupMigrationFailureMessage =
        "YardRelay could not safely migrate its Windows app data, so startup was stopped. "
        + "The legacy %LOCALAPPDATA%\\BHyveController folder was left in place, and YardRelay did not merge it into or overwrite %LOCALAPPDATA%\\YardRelay. "
        + "Close YardRelay, make sure both folders are accessible and are not symbolic links or junctions, then try again. "
        + "Do not delete or merge either folder. If the problem continues, preserve both folders and report the startup failure.";
    private const string CurrentAppDataName = "YardRelay";
    private const string LegacyAppDataName = "BHyveController";
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
    };

    public string AppDataDir { get; }
    public string ConfigDir { get; }
    public string DataDir { get; }
    public string LogDir { get; }
    public string SettingsPath { get; }
    public string SecretsPath { get; }
    public string YardRunConfigPath { get; }
    public string ServerRoot { get; }
    public string HelpPath { get; }

    internal static bool TryCreate(
        [NotNullWhen(true)] out DesktopPaths? paths,
        [NotNullWhen(false)] out string? failureMessage,
        string? serverRootOverride = null,
        string? localAppDataOverride = null)
    {
        try
        {
            paths = new DesktopPaths(serverRootOverride, localAppDataOverride);
            failureMessage = null;
            return true;
        }
        catch (Exception error) when (error is IOException
            or UnauthorizedAccessException
            or InvalidDataException
            or JsonException
            or SecurityException)
        {
            paths = null;
            failureMessage = StartupMigrationFailureMessage;
            return false;
        }
    }

    public DesktopPaths(string? serverRootOverride = null, string? localAppDataOverride = null)
    {
        var localAppData = localAppDataOverride
            ?? Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var legacyAppDataDir = Path.Combine(localAppData, LegacyAppDataName);
        var currentAppDataDir = Path.Combine(localAppData, CurrentAppDataName);

        MigrateLegacyAppData(legacyAppDataDir, currentAppDataDir);

        AppDataDir = currentAppDataDir;
        ConfigDir = Path.Combine(AppDataDir, "config");
        DataDir = Path.Combine(AppDataDir, "data");
        LogDir = Path.Combine(AppDataDir, "logs");
        SettingsPath = Path.Combine(AppDataDir, "settings.json");
        SecretsPath = Path.Combine(AppDataDir, "secrets.bin");
        YardRunConfigPath = Path.Combine(ConfigDir, "yard-runs.local.json");
        ServerRoot = ResolveServerRoot(serverRootOverride);
        HelpPath = Path.Combine(ServerRoot, "public", "help", "index.html");
    }

    public void EnsureUserDirectories()
    {
        Directory.CreateDirectory(AppDataDir);
        Directory.CreateDirectory(ConfigDir);
        Directory.CreateDirectory(DataDir);
        Directory.CreateDirectory(LogDir);
    }

    private static void MigrateLegacyAppData(string legacyRoot, string currentRoot)
    {
        if (!Directory.Exists(legacyRoot) || PathExists(currentRoot))
        {
            return;
        }

        if ((File.GetAttributes(legacyRoot) & FileAttributes.ReparsePoint) != 0)
        {
            throw new IOException($"Legacy app data cannot be migrated from a reparse point: {legacyRoot}");
        }

        var stagingRoot = Path.Combine(
            Path.GetDirectoryName(currentRoot) ?? throw new InvalidOperationException("App data root has no parent directory."),
            $".{CurrentAppDataName}.migration-{Guid.NewGuid():N}");

        try
        {
            CopyDirectory(new DirectoryInfo(legacyRoot), new DirectoryInfo(stagingRoot));
            RewriteLegacyDefaultPaths(stagingRoot, legacyRoot, currentRoot);

            try
            {
                Directory.Move(stagingRoot, currentRoot);
            }
            catch (IOException) when (PathExists(currentRoot))
            {
                DeleteStagingDirectory(stagingRoot);
            }
        }
        catch
        {
            DeleteStagingDirectory(stagingRoot);
            throw;
        }
    }

    private static void CopyDirectory(DirectoryInfo source, DirectoryInfo destination)
    {
        destination.Create();

        foreach (var entry in source.EnumerateFileSystemInfos())
        {
            if ((entry.Attributes & FileAttributes.ReparsePoint) != 0)
            {
                throw new IOException($"Legacy app data contains an unsupported reparse point: {entry.FullName}");
            }

            switch (entry)
            {
                case DirectoryInfo directory:
                    CopyDirectory(directory, new DirectoryInfo(Path.Combine(destination.FullName, directory.Name)));
                    break;
                case FileInfo file:
                    file.CopyTo(Path.Combine(destination.FullName, file.Name), overwrite: false);
                    break;
            }
        }
    }

    private static void RewriteLegacyDefaultPaths(string stagingRoot, string legacyRoot, string currentRoot)
    {
        var settingsPath = Path.Combine(stagingRoot, "settings.json");
        if (!File.Exists(settingsPath))
        {
            return;
        }

        var settings = JsonNode.Parse(File.ReadAllText(settingsPath)) as JsonObject
            ?? throw new InvalidDataException("Legacy settings.json must contain a JSON object.");
        var changed = RewriteExactPath(
            settings,
            "dataDir",
            Path.Combine(legacyRoot, "data"),
            Path.Combine(currentRoot, "data"));
        changed |= RewriteExactPath(
            settings,
            "yardRunConfigPath",
            Path.Combine(legacyRoot, "config", "yard-runs.local.json"),
            Path.Combine(currentRoot, "config", "yard-runs.local.json"));

        if (changed)
        {
            File.WriteAllText(settingsPath, settings.ToJsonString(JsonOptions) + Environment.NewLine);
        }
    }

    private static bool RewriteExactPath(JsonObject settings, string propertyName, string legacyPath, string currentPath)
    {
        if (settings[propertyName] is not JsonValue value
            || !value.TryGetValue<string>(out var configuredPath)
            || !string.Equals(
                configuredPath,
                legacyPath,
                OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
        {
            return false;
        }

        settings[propertyName] = currentPath;
        return true;
    }

    private static bool PathExists(string path)
    {
        return Directory.Exists(path) || File.Exists(path);
    }

    private static void DeleteStagingDirectory(string stagingRoot)
    {
        if (Directory.Exists(stagingRoot))
        {
            Directory.Delete(stagingRoot, recursive: true);
        }
    }

    private static string ResolveServerRoot(string? explicitRoot)
    {
        var candidates = new[]
        {
            explicitRoot,
            Environment.GetEnvironmentVariable("BHYVE_CONTROLLER_ROOT"),
            AppContext.BaseDirectory,
            Directory.GetCurrentDirectory(),
        };

        foreach (var candidate in candidates)
        {
            if (string.IsNullOrWhiteSpace(candidate))
            {
                continue;
            }

            var root = Path.GetFullPath(candidate);
            if (File.Exists(Path.Combine(root, "package.json")) && File.Exists(Path.Combine(root, "server", "app.js")))
            {
                return root;
            }
        }

        return AppContext.BaseDirectory;
    }
}

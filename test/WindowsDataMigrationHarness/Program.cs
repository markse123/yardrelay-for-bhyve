using System.Text.Json;
using BHyveControllerApp.Services;

var artifactRoot = Path.Combine(Path.GetTempPath(), $"yardrelay-windows-migration-{Guid.NewGuid():N}");
Directory.CreateDirectory(artifactRoot);

try
{
    VerifyLegacyDataMigration();
    VerifyExistingDestinationPreventsMigration();
    VerifyCustomPathsArePreserved();
    VerifyFailedMigrationRollsBack();
    VerifyMalformedCurrentSettingsArePreserved();
    Console.WriteLine("RESULT=PASS");
}
finally
{
    Directory.Delete(artifactRoot, recursive: true);
}

void VerifyLegacyDataMigration()
{
    var localAppData = Path.Combine(artifactRoot, "migration-defaults");
    var legacyRoot = Path.Combine(localAppData, "BHyveController");
    var currentRoot = Path.Combine(localAppData, "YardRelay");
    var legacySettingsPath = Path.Combine(legacyRoot, "settings.json");
    Directory.CreateDirectory(Path.Combine(legacyRoot, "config"));
    Directory.CreateDirectory(Path.Combine(legacyRoot, "data", "snapshots"));
    Directory.CreateDirectory(Path.Combine(legacyRoot, "logs"));
    File.WriteAllText(Path.Combine(legacyRoot, "config", "yard-runs.local.json"), "{\"version\":1}");
    File.WriteAllText(Path.Combine(legacyRoot, "data", "snapshots", "program.json"), "snapshot");
    File.WriteAllBytes(Path.Combine(legacyRoot, "secrets.bin"), [1, 2, 3, 4]);
    File.WriteAllText(legacySettingsPath, JsonSerializer.Serialize(new
    {
        version = 1,
        host = "127.0.0.1",
        port = 3030,
        dataDir = Path.Combine(legacyRoot, "data"),
        yardRunConfigPath = Path.Combine(legacyRoot, "config", "yard-runs.local.json"),
        retainedField = "retained",
    }));

    var paths = new DesktopPaths(serverRootOverride: artifactRoot, localAppDataOverride: localAppData);
    if (paths.AppDataDir != currentRoot
        || !File.Exists(Path.Combine(currentRoot, "data", "snapshots", "program.json"))
        || !File.Exists(Path.Combine(currentRoot, "config", "yard-runs.local.json"))
        || !File.ReadAllBytes(Path.Combine(currentRoot, "secrets.bin")).SequenceEqual(new byte[] { 1, 2, 3, 4 }))
    {
        throw new InvalidOperationException("Legacy app data was not copied to the YardRelay directory.");
    }

    using (var migrated = JsonDocument.Parse(File.ReadAllText(Path.Combine(currentRoot, "settings.json"))))
    {
        var settings = migrated.RootElement;
        if (settings.GetProperty("dataDir").GetString() != Path.Combine(currentRoot, "data")
            || settings.GetProperty("yardRunConfigPath").GetString() != Path.Combine(currentRoot, "config", "yard-runs.local.json")
            || settings.GetProperty("retainedField").GetString() != "retained")
        {
            throw new InvalidOperationException("Migrated settings did not rewrite only the legacy default paths.");
        }
    }

    using var legacy = JsonDocument.Parse(File.ReadAllText(legacySettingsPath));
    if (legacy.RootElement.GetProperty("dataDir").GetString() != Path.Combine(legacyRoot, "data")
        || !File.Exists(Path.Combine(legacyRoot, "data", "snapshots", "program.json")))
    {
        throw new InvalidOperationException("Legacy app data was modified or removed during migration.");
    }
}

void VerifyExistingDestinationPreventsMigration()
{
    var localAppData = Path.Combine(artifactRoot, "migration-existing-destination");
    var legacyRoot = Path.Combine(localAppData, "BHyveController");
    var currentRoot = Path.Combine(localAppData, "YardRelay");
    Directory.CreateDirectory(legacyRoot);
    Directory.CreateDirectory(currentRoot);
    File.WriteAllText(Path.Combine(legacyRoot, "legacy-only.txt"), "legacy");
    File.WriteAllText(Path.Combine(currentRoot, "current-only.txt"), "current");

    _ = new DesktopPaths(serverRootOverride: artifactRoot, localAppDataOverride: localAppData);
    if (File.Exists(Path.Combine(currentRoot, "legacy-only.txt"))
        || File.ReadAllText(Path.Combine(currentRoot, "current-only.txt")) != "current"
        || !File.Exists(Path.Combine(legacyRoot, "legacy-only.txt")))
    {
        throw new InvalidOperationException("Migration merged with or overwrote an existing YardRelay directory.");
    }
}

void VerifyCustomPathsArePreserved()
{
    var localAppData = Path.Combine(artifactRoot, "migration-custom-paths");
    var legacyRoot = Path.Combine(localAppData, "BHyveController");
    var currentRoot = Path.Combine(localAppData, "YardRelay");
    var customData = Path.Combine(localAppData, "custom-data");
    var customConfig = Path.Combine(localAppData, "custom-config.json");
    Directory.CreateDirectory(legacyRoot);
    File.WriteAllText(Path.Combine(legacyRoot, "settings.json"), JsonSerializer.Serialize(new
    {
        version = 1,
        dataDir = customData,
        yardRunConfigPath = customConfig,
    }));

    _ = new DesktopPaths(serverRootOverride: artifactRoot, localAppDataOverride: localAppData);
    using var migrated = JsonDocument.Parse(File.ReadAllText(Path.Combine(currentRoot, "settings.json")));
    if (migrated.RootElement.GetProperty("dataDir").GetString() != customData
        || migrated.RootElement.GetProperty("yardRunConfigPath").GetString() != customConfig
        || !File.Exists(Path.Combine(legacyRoot, "settings.json")))
    {
        throw new InvalidOperationException("Migration rewrote custom settings paths or removed the legacy settings file.");
    }
}

void VerifyFailedMigrationRollsBack()
{
    var localAppData = Path.Combine(artifactRoot, "migration-rollback");
    var legacyRoot = Path.Combine(localAppData, "BHyveController");
    var currentRoot = Path.Combine(localAppData, "YardRelay");
    var legacySettingsPath = Path.Combine(legacyRoot, "settings.json");
    var malformedSettings = "{\"dataDir\":"u8.ToArray();
    Directory.CreateDirectory(Path.Combine(legacyRoot, "data"));
    File.WriteAllBytes(legacySettingsPath, malformedSettings);
    File.WriteAllText(Path.Combine(legacyRoot, "data", "retained.txt"), "retained");

    var created = DesktopPaths.TryCreate(
        out var paths,
        out var failureMessage,
        serverRootOverride: artifactRoot,
        localAppDataOverride: localAppData);
    if (created || paths is not null || failureMessage is null)
    {
        throw new InvalidOperationException("Malformed legacy settings unexpectedly produced usable desktop paths.");
    }

    if (!failureMessage.Contains("startup was stopped", StringComparison.Ordinal)
        || !failureMessage.Contains(@"%LOCALAPPDATA%\BHyveController", StringComparison.Ordinal)
        || !failureMessage.Contains(@"%LOCALAPPDATA%\YardRelay", StringComparison.Ordinal)
        || !failureMessage.Contains("Do not delete or merge either folder", StringComparison.Ordinal)
        || failureMessage.Contains("dataDir", StringComparison.Ordinal))
    {
        throw new InvalidOperationException("Migration failure guidance was missing, unsafe, or exposed raw exception details.");
    }

    if (!File.ReadAllBytes(legacySettingsPath).SequenceEqual(malformedSettings)
        || File.ReadAllText(Path.Combine(legacyRoot, "data", "retained.txt")) != "retained"
        || Directory.Exists(currentRoot)
        || Directory.GetFileSystemEntries(localAppData, ".YardRelay.migration-*").Length != 0)
    {
        throw new InvalidOperationException("Failed migration did not leave the legacy tree intact and clean its staging directory.");
    }
}

void VerifyMalformedCurrentSettingsArePreserved()
{
    var localAppData = Path.Combine(artifactRoot, "malformed-current-settings");
    var currentRoot = Path.Combine(localAppData, "YardRelay");
    var settingsPath = Path.Combine(currentRoot, "settings.json");
    var malformedSettings = "{\"port\":"u8.ToArray();
    Directory.CreateDirectory(currentRoot);
    File.WriteAllBytes(settingsPath, malformedSettings);

    var paths = new DesktopPaths(serverRootOverride: artifactRoot, localAppDataOverride: localAppData);
    try
    {
        _ = new SettingsStore(paths).LoadOrDefault();
        throw new InvalidOperationException("Malformed YardRelay settings unexpectedly loaded or fell back to defaults.");
    }
    catch (JsonException)
    {
        // App.OnStartup catches the resulting MainWindow construction failure and exits.
    }

    if (!File.ReadAllBytes(settingsPath).SequenceEqual(malformedSettings))
    {
        throw new InvalidOperationException("Malformed YardRelay settings were modified during the failed startup read.");
    }
}

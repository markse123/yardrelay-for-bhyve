using System.Text.Json;
using BHyveControllerApp.Models;

namespace BHyveControllerApp.Services;

public sealed class SettingsStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
    };

    private readonly DesktopPaths _paths;

    public SettingsStore(DesktopPaths paths)
    {
        _paths = paths;
    }

    public DesktopSettings LoadOrDefault()
    {
        if (!File.Exists(_paths.SettingsPath))
        {
            return CreateDefault();
        }

        var json = File.ReadAllText(_paths.SettingsPath);
        var settings = JsonSerializer.Deserialize<DesktopSettings>(json, JsonOptions) ?? CreateDefault();
        Normalize(settings);
        return settings;
    }

    public void Save(DesktopSettings settings)
    {
        _paths.EnsureUserDirectories();
        Normalize(settings);
        File.WriteAllText(_paths.SettingsPath, JsonSerializer.Serialize(settings, JsonOptions));
    }

    public void Delete()
    {
        if (File.Exists(_paths.SettingsPath))
        {
            File.Delete(_paths.SettingsPath);
        }
    }

    public DesktopSettings CreateDefault()
    {
        return new DesktopSettings
        {
            Version = 1,
            Host = "127.0.0.1",
            Port = 3030,
            DataDir = _paths.DataDir,
            YardRunConfigPath = _paths.YardRunConfigPath,
        };
    }

    private void Normalize(DesktopSettings settings)
    {
        settings.Version = settings.Version <= 0 ? 1 : settings.Version;
        settings.Host = settings.Host is "localhost" ? "localhost" : "127.0.0.1";
        settings.DataDir = string.IsNullOrWhiteSpace(settings.DataDir) ? _paths.DataDir : settings.DataDir;
        settings.YardRunConfigPath = string.IsNullOrWhiteSpace(settings.YardRunConfigPath)
            ? _paths.YardRunConfigPath
            : settings.YardRunConfigPath;
    }
}

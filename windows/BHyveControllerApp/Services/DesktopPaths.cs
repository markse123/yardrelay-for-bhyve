namespace BHyveControllerApp.Services;

public sealed class DesktopPaths
{
    public string AppDataDir { get; }
    public string ConfigDir { get; }
    public string DataDir { get; }
    public string LogDir { get; }
    public string SettingsPath { get; }
    public string SecretsPath { get; }
    public string YardRunConfigPath { get; }
    public string ServerRoot { get; }
    public string HelpPath { get; }

    public DesktopPaths(string? serverRootOverride = null)
    {
        var localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        AppDataDir = Path.Combine(localAppData, "BHyveController");
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

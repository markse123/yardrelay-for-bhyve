namespace BHyveControllerApp.Services;

public sealed class DesktopPaths
{
    public DesktopPaths(string root)
    {
        AppDataDir = Path.Combine(root, "appdata");
        ConfigDir = Path.Combine(AppDataDir, "config");
        DataDir = Path.Combine(AppDataDir, "data");
        LogDir = Path.Combine(AppDataDir, "logs");
        ServerRoot = root;
    }

    public string AppDataDir { get; }
    public string ConfigDir { get; }
    public string DataDir { get; }
    public string LogDir { get; }
    public string ServerRoot { get; }

    public void EnsureUserDirectories()
    {
        Directory.CreateDirectory(AppDataDir);
        Directory.CreateDirectory(ConfigDir);
        Directory.CreateDirectory(DataDir);
        Directory.CreateDirectory(LogDir);
    }
}

public sealed class AppLogger
{
    public void Info(string message) { }
    public void Warn(string message) { }
}

public static class Redactor
{
    public static string ForLog(string value) => value;
}

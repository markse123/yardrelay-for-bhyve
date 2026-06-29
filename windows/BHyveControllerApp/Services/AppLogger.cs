namespace BHyveControllerApp.Services;

public sealed class AppLogger
{
    private const long MaxLogBytes = 512 * 1024;
    private readonly DesktopPaths _paths;
    private readonly object _lock = new();

    public AppLogger(DesktopPaths paths)
    {
        _paths = paths;
    }

    public void Info(string message)
    {
        Write("info", message);
    }

    public void Warn(string message)
    {
        Write("warn", message);
    }

    public string ReadRecent()
    {
        var path = LogPath();
        if (!File.Exists(path))
        {
            return string.Empty;
        }

        var text = File.ReadAllText(path);
        return text.Length <= 6000 ? text : text[^6000..];
    }

    private void Write(string level, string message)
    {
        _paths.EnsureUserDirectories();
        var line = $"{DateTimeOffset.UtcNow:O} {level} {Redactor.ForLog(message)}{Environment.NewLine}";
        lock (_lock)
        {
            var path = LogPath();
            if (File.Exists(path) && new FileInfo(path).Length > MaxLogBytes)
            {
                File.Move(path, Path.Combine(_paths.LogDir, "desktop.previous.log"), overwrite: true);
            }
            File.AppendAllText(path, line);
        }
    }

    private string LogPath()
    {
        return Path.Combine(_paths.LogDir, "desktop.log");
    }
}

namespace BHyveControllerApp.Models;

public sealed class DesktopSettings
{
    public int Version { get; set; } = 1;
    public string Host { get; set; } = "127.0.0.1";
    public int Port { get; set; } = 3030;
    public string? NodePath { get; set; }
    public string DataDir { get; set; } = string.Empty;
    public string YardRunConfigPath { get; set; } = string.Empty;
    public bool RequireWriteToken { get; set; }

    public string WriteAccessMode => RequireWriteToken ? "protected" : "local";

    public bool IsComplete()
    {
        return Version >= 1
            && Host is "127.0.0.1" or "localhost"
            && Port is >= 1024 and <= 65535
            && !string.IsNullOrWhiteSpace(DataDir)
            && !string.IsNullOrWhiteSpace(YardRunConfigPath);
    }
}

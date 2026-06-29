namespace BHyveControllerApp.Models;

public sealed class DesktopSecrets
{
    public string OrbitEmail { get; set; } = string.Empty;
    public string OrbitPassword { get; set; } = string.Empty;
    public string AppToken { get; set; } = string.Empty;

    public bool IsComplete()
    {
        return !string.IsNullOrWhiteSpace(OrbitEmail)
            && !string.IsNullOrWhiteSpace(OrbitPassword)
            && !string.IsNullOrWhiteSpace(AppToken);
    }
}

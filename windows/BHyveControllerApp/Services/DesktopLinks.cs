using System.Diagnostics;

namespace BHyveControllerApp.Services;

public static class DesktopLinks
{
    private static readonly HashSet<string> AllowedExternalHosts = new(StringComparer.OrdinalIgnoreCase)
    {
        "developer.microsoft.com",
        "github.com",
        "nodejs.org",
    };

    public static bool IsAllowedExternalUrl(string? value)
    {
        return Uri.TryCreate(value, UriKind.Absolute, out var uri)
            && uri.Scheme == Uri.UriSchemeHttps
            && string.IsNullOrEmpty(uri.UserInfo)
            && AllowedExternalHosts.Contains(uri.Host);
    }

    public static bool OpenAllowedExternalUrl(string? value)
    {
        if (!IsAllowedExternalUrl(value))
        {
            return false;
        }

        try
        {
            Process.Start(new ProcessStartInfo(value!) { UseShellExecute = true });
            return true;
        }
        catch
        {
            return false;
        }
    }
}

using System.Text.RegularExpressions;

namespace BHyveControllerApp.Services;

public static partial class Redactor
{
    public static string ForLog(string? value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return string.Empty;
        }

        var redacted = EmailRegex().Replace(value, "[redacted-email]");
        redacted = SecretLineRegex().Replace(redacted, "$1[redacted]");
        redacted = TokenRegex().Replace(redacted, "$1[redacted]");
        return redacted.Replace('\r', ' ').Replace('\n', ' ');
    }

    [GeneratedRegex(@"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", RegexOptions.IgnoreCase)]
    private static partial Regex EmailRegex();

    [GeneratedRegex(@"(?i)\b(ORBIT_PASSWORD|APP_TOKEN|X-App-Token|Authorization|Cookie)\b\s*[:=]\s*\S+")]
    private static partial Regex SecretLineRegex();

    [GeneratedRegex(@"(?i)\b(token|password|secret|session)\b([=:])\S+")]
    private static partial Regex TokenRegex();
}

using System.Security.Cryptography;

namespace BHyveControllerApp.Services;

public static class AppTokenPolicy
{
    public const int MinimumLength = 32;
    public const int MaximumLength = 512;
    public const int GeneratedTokenBytes = 32;

    private static readonly string[] KnownUnsafeValues =
    {
        "replace-with-a-long-random-local-token",
    };

    private static readonly string[] KnownUnsafeFragments =
    {
        "change-me",
        "changeme",
        "example-token",
        "password",
        "placeholder",
        "redacted",
        "replace-with",
        "sample-token",
        "your-app-token",
    };

    public static bool TryNormalize(string? value, out string normalized)
    {
        normalized = string.Empty;
        if (value is null || value.Length is < MinimumLength or > MaximumLength)
        {
            return false;
        }

        var candidate = value.Trim();
        var lowered = candidate.ToLowerInvariant();
        if (!string.Equals(candidate, value, StringComparison.Ordinal)
            || KnownUnsafeValues.Contains(lowered, StringComparer.Ordinal)
            || KnownUnsafeFragments.Any(fragment => lowered.Contains(fragment, StringComparison.Ordinal)))
        {
            return false;
        }

        foreach (var character in candidate)
        {
            // APP_TOKEN crosses JSON, DPAPI, process-environment, URL-fragment, and HTTP-header boundaries.
            // Keep one unambiguous printable-ASCII contract at every boundary.
            if (character is < ' ' or > '~')
            {
                return false;
            }
        }

        normalized = candidate;
        return true;
    }

    public static string NormalizeOrGenerate(string? value, out bool generated)
    {
        if (TryNormalize(value, out var normalized))
        {
            generated = false;
            return normalized;
        }

        generated = true;
        return GenerateAppToken();
    }

    public static string GenerateAppToken()
    {
        Span<byte> bytes = stackalloc byte[GeneratedTokenBytes];
        RandomNumberGenerator.Fill(bytes);
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }
}

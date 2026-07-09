using System.Security.Cryptography;
using System.Text;

namespace BHyveControllerApp.Services;

public static class ServiceIdentity
{
    public const string ServiceName = "bhyve-local-controller";
    public const int ProtocolVersion = 2;
    public const int ChallengeBytes = 32;
    public const string IdentityPurpose = "identity";
    public const string ShutdownPurpose = "shutdown";

    private static readonly string ProofPrefix = $"{ServiceName}\n{ProtocolVersion}\n";

    public static string CreateChallenge()
    {
        Span<byte> bytes = stackalloc byte[ChallengeBytes];
        RandomNumberGenerator.Fill(bytes);
        return Base64UrlEncode(bytes);
    }

    public static string CreateLoopbackOrigin(string host, int port)
    {
        if (!string.Equals(host, "127.0.0.1", StringComparison.Ordinal) || port is < 1 or > 65535)
        {
            throw new ArgumentException("Controller origin is invalid.");
        }

        return CanonicalizeLoopbackOrigin(new UriBuilder(Uri.UriSchemeHttp, host, port).Uri.GetLeftPart(UriPartial.Authority));
    }

    public static string CanonicalizeLoopbackOrigin(string origin)
    {
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var uri)
            || !string.Equals(uri.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase)
            || !string.IsNullOrEmpty(uri.UserInfo)
            || uri.AbsolutePath != "/"
            || !string.IsNullOrEmpty(uri.Query)
            || !string.IsNullOrEmpty(uri.Fragment)
            || !string.Equals(uri.Host, "127.0.0.1", StringComparison.Ordinal))
        {
            throw new ArgumentException("Controller origin must be an HTTP loopback origin.", nameof(origin));
        }

        return new UriBuilder(Uri.UriSchemeHttp, "127.0.0.1", uri.Port).Uri.GetLeftPart(UriPartial.Authority);
    }

    public static string CreateProof(string appToken, string challenge, string purpose, string origin)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(appToken);
        if (!IsValidChallenge(challenge))
        {
            throw new ArgumentException("Controller identity challenge is invalid.", nameof(challenge));
        }
        if (purpose is not IdentityPurpose and not ShutdownPurpose)
        {
            throw new ArgumentException("Controller proof purpose is invalid.", nameof(purpose));
        }
        var canonicalOrigin = CanonicalizeLoopbackOrigin(origin);
        if (!string.Equals(canonicalOrigin, origin, StringComparison.Ordinal))
        {
            throw new ArgumentException("Controller origin must be canonical.", nameof(origin));
        }

        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(appToken));
        return Base64UrlEncode(hmac.ComputeHash(Encoding.UTF8.GetBytes($"{ProofPrefix}{purpose}\n{canonicalOrigin}\n{challenge}")));
    }

    public static bool VerifyProof(string appToken, string challenge, string purpose, string origin, string? proof)
    {
        if (string.IsNullOrWhiteSpace(proof))
        {
            return false;
        }

        try
        {
            var expected = Base64UrlDecode(CreateProof(appToken, challenge, purpose, origin));
            var actual = Base64UrlDecode(proof);
            return expected.Length == actual.Length
                && CryptographicOperations.FixedTimeEquals(expected, actual);
        }
        catch (FormatException)
        {
            return false;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    public static bool IsValidChallenge(string? challenge)
    {
        if (string.IsNullOrWhiteSpace(challenge) || challenge.Length != 43)
        {
            return false;
        }

        try
        {
            var decoded = Base64UrlDecode(challenge);
            return decoded.Length == ChallengeBytes
                && string.Equals(Base64UrlEncode(decoded), challenge, StringComparison.Ordinal);
        }
        catch (FormatException)
        {
            return false;
        }
    }

    private static string Base64UrlEncode(ReadOnlySpan<byte> value)
    {
        return Convert.ToBase64String(value)
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');
    }

    private static byte[] Base64UrlDecode(string value)
    {
        var normalized = value.Replace('-', '+').Replace('_', '/');
        normalized = normalized.PadRight(normalized.Length + ((4 - normalized.Length % 4) % 4), '=');
        return Convert.FromBase64String(normalized);
    }
}

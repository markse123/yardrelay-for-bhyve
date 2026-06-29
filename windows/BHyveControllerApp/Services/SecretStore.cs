using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using BHyveControllerApp.Models;

namespace BHyveControllerApp.Services;

public sealed class SecretStore
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("BHyveController.Windows.Secrets.v1");
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    private readonly DesktopPaths _paths;

    public SecretStore(DesktopPaths paths)
    {
        _paths = paths;
    }

    public DesktopSecrets LoadOrDefault()
    {
        if (!File.Exists(_paths.SecretsPath))
        {
            return new DesktopSecrets();
        }

        var encrypted = File.ReadAllBytes(_paths.SecretsPath);
        var plain = ProtectedData.Unprotect(encrypted, Entropy, DataProtectionScope.CurrentUser);
        return JsonSerializer.Deserialize<DesktopSecrets>(plain, JsonOptions) ?? new DesktopSecrets();
    }

    public void Save(DesktopSecrets secrets)
    {
        _paths.EnsureUserDirectories();
        var plain = JsonSerializer.SerializeToUtf8Bytes(secrets, JsonOptions);
        var encrypted = ProtectedData.Protect(plain, Entropy, DataProtectionScope.CurrentUser);
        File.WriteAllBytes(_paths.SecretsPath, encrypted);
    }

    public void Delete()
    {
        if (File.Exists(_paths.SecretsPath))
        {
            File.Delete(_paths.SecretsPath);
        }
    }

    public static string GenerateAppToken()
    {
        Span<byte> bytes = stackalloc byte[32];
        RandomNumberGenerator.Fill(bytes);
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }
}

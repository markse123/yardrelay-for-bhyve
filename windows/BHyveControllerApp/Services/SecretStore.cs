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
        return LoadOrDefault(out _);
    }

    public DesktopSecrets LoadOrDefault(out bool rejectedUnsafeAppToken)
    {
        rejectedUnsafeAppToken = false;
        if (!File.Exists(_paths.SecretsPath))
        {
            return new DesktopSecrets();
        }

        var encrypted = File.ReadAllBytes(_paths.SecretsPath);
        var plain = ProtectedData.Unprotect(encrypted, Entropy, DataProtectionScope.CurrentUser);
        var secrets = JsonSerializer.Deserialize<DesktopSecrets>(plain, JsonOptions) ?? new DesktopSecrets();
        if (!string.IsNullOrEmpty(secrets.AppToken)
            && !AppTokenPolicy.TryNormalize(secrets.AppToken, out _))
        {
            secrets.AppToken = string.Empty;
            rejectedUnsafeAppToken = true;
        }
        return secrets;
    }

    public void Save(DesktopSecrets secrets)
    {
        if (!AppTokenPolicy.TryNormalize(secrets.AppToken, out var appToken))
        {
            throw new InvalidDataException("The app token does not meet the Windows security requirements.");
        }

        _paths.EnsureUserDirectories();
        var safeSecrets = new DesktopSecrets
        {
            OrbitEmail = secrets.OrbitEmail,
            OrbitPassword = secrets.OrbitPassword,
            AppToken = appToken,
        };
        var plain = JsonSerializer.SerializeToUtf8Bytes(safeSecrets, JsonOptions);
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

}

using System.Diagnostics;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using BHyveControllerApp.Models;

namespace BHyveControllerApp.Services;

public enum ControllerProbeStatus
{
    Unreachable,
    Verified,
    Untrusted,
}

public sealed record ControllerProbeResult(ControllerProbeStatus Status, string? Challenge = null);

public sealed class ServerController : IDisposable
{
    private readonly DesktopPaths _paths;
    private readonly AppLogger _logger;
    private readonly HttpClient _httpClient = new(new HttpClientHandler
    {
        AllowAutoRedirect = false,
        UseProxy = false,
    });
    private Process? _process;
    private DesktopSettings? _settings;
    private DesktopSecrets? _secrets;
    private bool _serviceVerified;

    public event Action<string>? MessageChanged;

    public bool IsManagedRunning => _process is { HasExited: false };
    public Uri? ControllerUri => _settings is null ? null : new Uri($"http://{_settings.Host}:{_settings.Port}");
    public Uri? ControllerBrowserUri
    {
        get
        {
            var controllerUri = ControllerUri;
            if (!_serviceVerified || controllerUri is null || string.IsNullOrWhiteSpace(_secrets?.AppToken))
            {
                return null;
            }

            return new UriBuilder(controllerUri)
            {
                Fragment = $"token={Uri.EscapeDataString(_secrets.AppToken)}",
            }.Uri;
        }
    }

    public bool IsControllerNavigationUri(Uri? candidate)
    {
        var controllerUri = ControllerUri;
        return controllerUri is not null
            && candidate is { IsAbsoluteUri: true }
            && string.Equals(candidate.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase)
            && string.Equals(candidate.Scheme, controllerUri.Scheme, StringComparison.OrdinalIgnoreCase)
            && string.Equals(candidate.Host, controllerUri.Host, StringComparison.OrdinalIgnoreCase)
            && candidate.Port == controllerUri.Port
            && string.IsNullOrEmpty(candidate.UserInfo);
    }

    public ServerController(DesktopPaths paths, AppLogger logger)
    {
        _paths = paths;
        _logger = logger;
    }

    public async Task<ControllerProbeResult> ProbeAsync(
        DesktopSettings settings,
        DesktopSecrets secrets,
        CancellationToken cancellationToken = default)
    {
        var challenge = ServiceIdentity.CreateChallenge();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeout.Token);
        try
        {
            var identityUri = new Uri(
                $"http://{settings.Host}:{settings.Port}/api/identity?challenge={Uri.EscapeDataString(challenge)}");
            using var response = await _httpClient.GetAsync(
                identityUri,
                HttpCompletionOption.ResponseHeadersRead,
                linked.Token);
            if (response.StatusCode != HttpStatusCode.OK
                || response.RequestMessage?.RequestUri != identityUri)
            {
                return new ControllerProbeResult(ControllerProbeStatus.Untrusted);
            }

            var body = await ReadBoundedContentAsync(response.Content, 4096, linked.Token);
            var identity = JsonSerializer.Deserialize<ControllerIdentityResponse>(body, JsonOptions);
            return identity is not null
                && string.Equals(identity.Service, ServiceIdentity.ServiceName, StringComparison.Ordinal)
                && identity.ProtocolVersion == ServiceIdentity.ProtocolVersion
                && string.Equals(identity.Challenge, challenge, StringComparison.Ordinal)
                && ServiceIdentity.VerifyProof(
                    secrets.AppToken,
                    challenge,
                    ServiceIdentity.IdentityPurpose,
                    identity.Proof)
                    ? new ControllerProbeResult(ControllerProbeStatus.Verified, challenge)
                    : new ControllerProbeResult(ControllerProbeStatus.Untrusted);
        }
        catch (HttpRequestException)
        {
            return new ControllerProbeResult(ControllerProbeStatus.Unreachable);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return new ControllerProbeResult(ControllerProbeStatus.Untrusted);
        }
        catch (JsonException)
        {
            return new ControllerProbeResult(ControllerProbeStatus.Untrusted);
        }
        catch (InvalidDataException)
        {
            return new ControllerProbeResult(ControllerProbeStatus.Untrusted);
        }
    }

    public async Task<bool> IsReachableAsync(
        DesktopSettings settings,
        DesktopSecrets secrets,
        CancellationToken cancellationToken = default)
    {
        return (await ProbeAsync(settings, secrets, cancellationToken)).Status == ControllerProbeStatus.Verified;
    }

    public async Task StartAsync(string nodePath, DesktopSettings settings, DesktopSecrets secrets, CancellationToken cancellationToken = default)
    {
        _settings = settings;
        _secrets = secrets;
        _paths.EnsureUserDirectories();
        Directory.CreateDirectory(settings.DataDir);
        Directory.CreateDirectory(Path.GetDirectoryName(settings.YardRunConfigPath) ?? _paths.ConfigDir);

        if (IsManagedRunning)
        {
            SetMessage("Server is already running from this app.");
            return;
        }

        _serviceVerified = false;

        var existing = await ProbeAsync(settings, secrets, cancellationToken);
        if (existing.Status == ControllerProbeStatus.Verified)
        {
            _serviceVerified = true;
            SetMessage("A controller server is already reachable on the configured port.");
            return;
        }
        if (existing.Status == ControllerProbeStatus.Untrusted)
        {
            throw new InvalidOperationException("The configured port is occupied by a service that could not authenticate as this controller.");
        }

        var appScript = Path.Combine(_paths.ServerRoot, "server", "app.js");
        if (!File.Exists(appScript))
        {
            throw new InvalidOperationException("The packaged server/app.js file was not found.");
        }

        var startInfo = new ProcessStartInfo(nodePath)
        {
            WorkingDirectory = _paths.ServerRoot,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        AddBaseEnvironment(startInfo);
        startInfo.ArgumentList.Add("server/app.js");
        startInfo.Environment["ORBIT_EMAIL"] = secrets.OrbitEmail;
        startInfo.Environment["ORBIT_PASSWORD"] = secrets.OrbitPassword;
        startInfo.Environment["APP_TOKEN"] = secrets.AppToken;
        startInfo.Environment["HOST"] = settings.Host;
        startInfo.Environment["PORT"] = settings.Port.ToString();
        startInfo.Environment["BHYVE_DATA_DIR"] = settings.DataDir;
        startInfo.Environment["YARD_RUN_CONFIG"] = settings.YardRunConfigPath;
        startInfo.Environment["WRITE_ACCESS_MODE"] = settings.WriteAccessMode;

        _process = new Process
        {
            StartInfo = startInfo,
            EnableRaisingEvents = true,
        };
        _process.OutputDataReceived += (_, args) => LogServerLine(args.Data);
        _process.ErrorDataReceived += (_, args) => LogServerLine(args.Data);
        _process.Exited += (_, _) =>
        {
            SetMessage($"Server exited with status {_process?.ExitCode}.");
            _logger.Warn($"server exited status={_process?.ExitCode}");
        };

        if (!_process.Start())
        {
            throw new InvalidOperationException("Could not start the controller server.");
        }

        _process.BeginOutputReadLine();
        _process.BeginErrorReadLine();
        _logger.Info("started managed controller server");
        SetMessage("Starting controller server...");
        await WaitUntilReachableAsync(settings, secrets, cancellationToken);
        _serviceVerified = true;
    }

    public async Task StopAsync(CancellationToken cancellationToken = default)
    {
        var settings = _settings;
        var secrets = _secrets;
        if (settings is not null && secrets is not null)
        {
            var probe = await ProbeAsync(settings, secrets, cancellationToken);
            if (probe is { Status: ControllerProbeStatus.Verified, Challenge: not null })
            {
                try
                {
                    using var request = new HttpRequestMessage(HttpMethod.Post, $"http://{settings.Host}:{settings.Port}/api/shutdown")
                    {
                        Content = new StringContent("{}", Encoding.UTF8, "application/json"),
                    };
                    request.Headers.Add("X-Controller-Challenge", probe.Challenge);
                    request.Headers.Add(
                        "X-Controller-Proof",
                        ServiceIdentity.CreateProof(
                            secrets.AppToken,
                            probe.Challenge,
                            ServiceIdentity.ShutdownPurpose));
                    await _httpClient.SendAsync(request, cancellationToken);
                }
                catch (Exception error)
                {
                    _logger.Warn($"shutdown request failed: {error.Message}");
                }
            }
        }

        if (_process is { HasExited: false } process)
        {
            try
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(4));
                using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeout.Token);
                await process.WaitForExitAsync(linked.Token);
            }
            catch
            {
                TryKill(_process);
            }
        }

        _process = null;
        _serviceVerified = false;
        SetMessage("Server is stopped.");
        _logger.Info("stopped managed controller server");
    }

    public async Task RestartAsync(string nodePath, DesktopSettings settings, DesktopSecrets secrets, CancellationToken cancellationToken = default)
    {
        await StopAsync(cancellationToken);
        await StartAsync(nodePath, settings, secrets, cancellationToken);
    }

    public void Dispose()
    {
        _httpClient.Dispose();
        if (_process is { HasExited: false })
        {
            TryKill(_process);
        }
        _process?.Dispose();
    }

    private async Task WaitUntilReachableAsync(
        DesktopSettings settings,
        DesktopSecrets secrets,
        CancellationToken cancellationToken)
    {
        for (var attempt = 0; attempt < 24; attempt += 1)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var probe = await ProbeAsync(settings, secrets, cancellationToken);
            if (probe.Status == ControllerProbeStatus.Verified)
            {
                SetMessage("Server is running.");
                return;
            }
            if (probe.Status == ControllerProbeStatus.Untrusted)
            {
                throw new InvalidOperationException("The configured port was claimed by a service that could not authenticate as this controller.");
            }
            await Task.Delay(500, cancellationToken);
        }

        SetMessage("Server started but did not become reachable.");
    }

    private void LogServerLine(string? line)
    {
        if (string.IsNullOrWhiteSpace(line))
        {
            return;
        }

        var redacted = Redactor.ForLog(line);
        _logger.Info($"server: {redacted}");
        SetMessage(redacted);
    }

    private void SetMessage(string message)
    {
        MessageChanged?.Invoke(message);
    }

    private static void TryKill(Process? process)
    {
        try
        {
            if (process is { HasExited: false })
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch
        {
            // Best-effort cleanup only.
        }
    }

    private static void AddBaseEnvironment(ProcessStartInfo startInfo)
    {
        startInfo.Environment.Clear();
        foreach (var key in new[] { "SystemRoot", "WINDIR", "PATH", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA" })
        {
            var value = Environment.GetEnvironmentVariable(key);
            if (!string.IsNullOrWhiteSpace(value))
            {
                startInfo.Environment[key] = value;
            }
        }
    }

    private static async Task<byte[]> ReadBoundedContentAsync(
        HttpContent content,
        int maxBytes,
        CancellationToken cancellationToken)
    {
        await using var stream = await content.ReadAsStreamAsync(cancellationToken);
        using var buffer = new MemoryStream(capacity: maxBytes);
        var chunk = new byte[1024];
        while (true)
        {
            var read = await stream.ReadAsync(chunk.AsMemory(), cancellationToken);
            if (read == 0)
            {
                return buffer.ToArray();
            }
            if (buffer.Length + read > maxBytes)
            {
                throw new InvalidDataException("Controller identity response exceeded the size limit.");
            }
            await buffer.WriteAsync(chunk.AsMemory(0, read), cancellationToken);
        }
    }

    private sealed class ControllerIdentityResponse
    {
        public string Service { get; init; } = string.Empty;
        public int ProtocolVersion { get; init; }
        public string Challenge { get; init; } = string.Empty;
        public string Proof { get; init; } = string.Empty;
    }

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
}

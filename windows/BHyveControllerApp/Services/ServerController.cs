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
    private readonly object _stateGate = new();
    private readonly int _startupProbeAttempts;
    private readonly TimeSpan _startupProbeDelay;
    private readonly TimeSpan _identityMonitorInterval;
    private readonly HttpClient _httpClient = new(new HttpClientHandler
    {
        AllowAutoRedirect = false,
        UseProxy = false,
    });
    private Process? _process;
    private DesktopSettings? _activeSettings;
    private DesktopSecrets? _activeSecrets;
    private string? _verifiedOrigin;
    private string? _verifiedAppToken;
    private CancellationTokenSource? _identityMonitorCancellation;
    private bool _serviceVerified;

    public event Action<string>? MessageChanged;
    public event Action? TrustRevoked;

    public bool IsManagedRunning
    {
        get
        {
            lock (_stateGate)
            {
                return IsProcessRunning(_process);
            }
        }
    }
    public Uri? ControllerUri
    {
        get
        {
            lock (_stateGate)
            {
                return _serviceVerified && _verifiedOrigin is not null
                    ? new Uri(_verifiedOrigin)
                    : null;
            }
        }
    }
    public Uri? ControllerBrowserUri
    {
        get
        {
            string? verifiedOrigin;
            string? verifiedAppToken;
            lock (_stateGate)
            {
                if (!_serviceVerified
                    || string.IsNullOrWhiteSpace(_verifiedOrigin)
                    || string.IsNullOrWhiteSpace(_verifiedAppToken))
                {
                    return null;
                }
                verifiedOrigin = _verifiedOrigin;
                verifiedAppToken = _verifiedAppToken;
            }

            return new UriBuilder(new Uri(verifiedOrigin))
            {
                Fragment = $"token={Uri.EscapeDataString(verifiedAppToken)}",
            }.Uri;
        }
    }

    public bool IsControllerNavigationUri(Uri? candidate)
    {
        string? verifiedOrigin;
        lock (_stateGate)
        {
            verifiedOrigin = _serviceVerified ? _verifiedOrigin : null;
        }
        var controllerUri = verifiedOrigin is null ? null : new Uri(verifiedOrigin);
        return controllerUri is not null
            && candidate is { IsAbsoluteUri: true }
            && string.Equals(candidate.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase)
            && string.Equals(candidate.Scheme, controllerUri.Scheme, StringComparison.OrdinalIgnoreCase)
            && string.Equals(candidate.Host, controllerUri.Host, StringComparison.OrdinalIgnoreCase)
            && candidate.Port == controllerUri.Port
            && string.IsNullOrEmpty(candidate.UserInfo);
    }

    public ServerController(
        DesktopPaths paths,
        AppLogger logger,
        int startupProbeAttempts = 24,
        TimeSpan? startupProbeDelay = null,
        TimeSpan? identityMonitorInterval = null)
    {
        if (startupProbeAttempts < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(startupProbeAttempts));
        }
        _paths = paths;
        _logger = logger;
        _startupProbeAttempts = startupProbeAttempts;
        _startupProbeDelay = startupProbeDelay ?? TimeSpan.FromMilliseconds(500);
        _identityMonitorInterval = identityMonitorInterval ?? TimeSpan.FromSeconds(2);
        if (_startupProbeDelay < TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(startupProbeDelay));
        }
        if (_identityMonitorInterval <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(identityMonitorInterval));
        }
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
            var expectedOrigin = ServiceIdentity.CreateLoopbackOrigin(settings.Host, settings.Port);
            var identityUri = new Uri($"{expectedOrigin}/api/identity?challenge={Uri.EscapeDataString(challenge)}");
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
                && string.Equals(identity.Origin, expectedOrigin, StringComparison.Ordinal)
                && ServiceIdentity.VerifyProof(
                    secrets.AppToken,
                    challenge,
                    ServiceIdentity.IdentityPurpose,
                    expectedOrigin,
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
        if (IsManagedRunning)
        {
            SetMessage("Server is already running from this app.");
            return;
        }

        var settingsSnapshot = SnapshotSettings(settings);
        var secretsSnapshot = SnapshotSecrets(secrets);
        RevokeTrust();
        ClearStoppedProcess();
        lock (_stateGate)
        {
            _activeSettings = settingsSnapshot;
            _activeSecrets = secretsSnapshot;
        }
        _paths.EnsureUserDirectories();
        Directory.CreateDirectory(settingsSnapshot.DataDir);
        Directory.CreateDirectory(Path.GetDirectoryName(settingsSnapshot.YardRunConfigPath) ?? _paths.ConfigDir);

        var existing = await ProbeAsync(settingsSnapshot, secretsSnapshot, cancellationToken);
        if (existing.Status == ControllerProbeStatus.Verified)
        {
            if (!EstablishTrust(settingsSnapshot, secretsSnapshot))
            {
                throw new InvalidOperationException("The existing controller could not retain verified trust.");
            }
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
        startInfo.Environment["ORBIT_EMAIL"] = secretsSnapshot.OrbitEmail;
        startInfo.Environment["ORBIT_PASSWORD"] = secretsSnapshot.OrbitPassword;
        startInfo.Environment["APP_TOKEN"] = secretsSnapshot.AppToken;
        startInfo.Environment["HOST"] = settingsSnapshot.Host;
        startInfo.Environment["PORT"] = settingsSnapshot.Port.ToString();
        startInfo.Environment["BHYVE_DATA_DIR"] = settingsSnapshot.DataDir;
        startInfo.Environment["YARD_RUN_CONFIG"] = settingsSnapshot.YardRunConfigPath;
        startInfo.Environment["WRITE_ACCESS_MODE"] = settingsSnapshot.WriteAccessMode;

        var process = new Process
        {
            StartInfo = startInfo,
            EnableRaisingEvents = true,
        };
        process.OutputDataReceived += (_, args) => LogServerLine(args.Data);
        process.ErrorDataReceived += (_, args) => LogServerLine(args.Data);
        process.Exited += (_, _) => HandleProcessExited(process);

        if (!process.Start())
        {
            process.Dispose();
            throw new InvalidOperationException("Could not start the controller server.");
        }

        lock (_stateGate)
        {
            _process = process;
        }
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        _logger.Info("started managed controller server");
        SetMessage("Starting controller server...");
        try
        {
            await WaitUntilReachableAsync(settingsSnapshot, secretsSnapshot, cancellationToken);
            if (!EstablishTrust(settingsSnapshot, secretsSnapshot, process))
            {
                throw new InvalidOperationException("The controller process exited before service identity was verified.");
            }
        }
        catch
        {
            RevokeTrust(process, clearProcess: true);
            TryKill(process);
            process.Dispose();
            throw;
        }
    }

    public async Task StopAsync(CancellationToken cancellationToken = default)
    {
        RevokeTrust();
        DesktopSettings? settings;
        DesktopSecrets? secrets;
        lock (_stateGate)
        {
            settings = _activeSettings;
            secrets = _activeSecrets;
        }
        if (settings is not null && secrets is not null)
        {
            var probe = await ProbeAsync(settings, secrets, cancellationToken);
            if (probe is { Status: ControllerProbeStatus.Verified, Challenge: not null })
            {
                try
                {
                    var controllerOrigin = ServiceIdentity.CreateLoopbackOrigin(settings.Host, settings.Port);
                    using var request = new HttpRequestMessage(HttpMethod.Post, $"{controllerOrigin}/api/shutdown")
                    {
                        Content = new StringContent("{}", Encoding.UTF8, "application/json"),
                    };
                    request.Headers.Add("X-Controller-Challenge", probe.Challenge);
                    request.Headers.Add(
                        "X-Controller-Proof",
                        ServiceIdentity.CreateProof(
                            secrets.AppToken,
                            probe.Challenge,
                            ServiceIdentity.ShutdownPurpose,
                            controllerOrigin));
                    await _httpClient.SendAsync(request, cancellationToken);
                }
                catch (Exception error)
                {
                    _logger.Warn($"shutdown request failed: {error.Message}");
                }
            }
        }

        Process? process;
        lock (_stateGate)
        {
            process = _process;
        }
        if (process is not null && IsProcessRunning(process))
        {
            try
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(4));
                using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeout.Token);
                await process.WaitForExitAsync(linked.Token);
            }
            catch
            {
                TryKill(process);
            }
        }

        lock (_stateGate)
        {
            if (ReferenceEquals(_process, process))
            {
                _process = null;
            }
        }
        process?.Dispose();
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
        RevokeTrust();
        _httpClient.Dispose();
        Process? process;
        lock (_stateGate)
        {
            process = _process;
            _process = null;
        }
        TryKill(process);
        process?.Dispose();
    }

    private async Task WaitUntilReachableAsync(
        DesktopSettings settings,
        DesktopSecrets secrets,
        CancellationToken cancellationToken)
    {
        for (var attempt = 0; attempt < _startupProbeAttempts; attempt += 1)
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
            await Task.Delay(_startupProbeDelay, cancellationToken);
        }

        SetMessage("Server started but did not become reachable.");
        throw new TimeoutException("Server started but did not become reachable or prove its identity.");
    }

    private bool EstablishTrust(
        DesktopSettings settings,
        DesktopSecrets secrets,
        Process? expectedProcess = null)
    {
        var verifiedOrigin = ServiceIdentity.CreateLoopbackOrigin(settings.Host, settings.Port);
        var monitorCancellation = new CancellationTokenSource();
        CancellationTokenSource? previousMonitor;
        lock (_stateGate)
        {
            if (expectedProcess is not null
                && (!ReferenceEquals(_process, expectedProcess) || !IsProcessRunning(expectedProcess)))
            {
                monitorCancellation.Dispose();
                return false;
            }

            previousMonitor = _identityMonitorCancellation;
            _identityMonitorCancellation = monitorCancellation;
            _verifiedOrigin = verifiedOrigin;
            _verifiedAppToken = secrets.AppToken;
            _serviceVerified = true;
        }
        previousMonitor?.Cancel();
        _ = MonitorVerifiedServiceAsync(
            SnapshotSettings(settings),
            SnapshotSecrets(secrets),
            monitorCancellation);
        return true;
    }

    private async Task MonitorVerifiedServiceAsync(
        DesktopSettings settings,
        DesktopSecrets secrets,
        CancellationTokenSource monitorCancellation)
    {
        var cancellationToken = monitorCancellation.Token;
        try
        {
            while (true)
            {
                await Task.Delay(_identityMonitorInterval, cancellationToken);
                var probe = await ProbeAsync(settings, secrets, cancellationToken);
                if (probe.Status == ControllerProbeStatus.Verified)
                {
                    continue;
                }

                if (RevokeTrust(expectedMonitor: monitorCancellation))
                {
                    SetMessage("Controller identity could no longer be verified. Browser trust was revoked.");
                    _logger.Warn($"controller identity monitor revoked trust status={probe.Status}");
                }
                return;
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // Expected when trust is revoked, the controller stops, or the app exits.
        }
        catch (Exception error)
        {
            if (RevokeTrust(expectedMonitor: monitorCancellation))
            {
                SetMessage("Controller identity monitoring failed. Browser trust was revoked.");
                _logger.Warn($"controller identity monitor failed: {Redactor.ForLog(error.Message)}");
            }
        }
        finally
        {
            monitorCancellation.Dispose();
        }
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

    private void HandleProcessExited(Process process)
    {
        int? exitCode = null;
        try
        {
            exitCode = process.ExitCode;
        }
        catch
        {
            // The process can be disposed concurrently during explicit shutdown.
        }

        if (!RevokeTrust(process, clearProcess: true))
        {
            return;
        }
        SetMessage($"Server exited with status {exitCode?.ToString() ?? "unknown"}.");
        _logger.Warn($"server exited status={exitCode?.ToString() ?? "unknown"}");
    }

    private bool RevokeTrust(
        Process? expectedProcess = null,
        bool clearProcess = false,
        CancellationTokenSource? expectedMonitor = null)
    {
        bool notify;
        CancellationTokenSource? monitorCancellation;
        lock (_stateGate)
        {
            if (expectedProcess is not null && !ReferenceEquals(_process, expectedProcess))
            {
                return false;
            }
            if (expectedMonitor is not null
                && !ReferenceEquals(_identityMonitorCancellation, expectedMonitor))
            {
                return false;
            }
            notify = _serviceVerified;
            _serviceVerified = false;
            _verifiedOrigin = null;
            _verifiedAppToken = null;
            monitorCancellation = _identityMonitorCancellation;
            _identityMonitorCancellation = null;
            if (clearProcess)
            {
                _process = null;
            }
        }
        monitorCancellation?.Cancel();
        if (notify)
        {
            TrustRevoked?.Invoke();
        }
        return true;
    }

    private static DesktopSettings SnapshotSettings(DesktopSettings source)
    {
        return new DesktopSettings
        {
            Version = source.Version,
            Host = source.Host,
            Port = source.Port,
            NodePath = source.NodePath,
            DataDir = source.DataDir,
            YardRunConfigPath = source.YardRunConfigPath,
            RequireWriteToken = source.RequireWriteToken,
        };
    }

    private static DesktopSecrets SnapshotSecrets(DesktopSecrets source)
    {
        return new DesktopSecrets
        {
            OrbitEmail = source.OrbitEmail,
            OrbitPassword = source.OrbitPassword,
            AppToken = source.AppToken,
        };
    }

    private void ClearStoppedProcess()
    {
        Process? stopped = null;
        lock (_stateGate)
        {
            if (_process is not null && !IsProcessRunning(_process))
            {
                stopped = _process;
                _process = null;
            }
        }
        stopped?.Dispose();
    }

    private static bool IsProcessRunning(Process? process)
    {
        try
        {
            return process is not null && !process.HasExited;
        }
        catch
        {
            return false;
        }
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
        public string Origin { get; init; } = string.Empty;
        public string Proof { get; init; } = string.Empty;
    }

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
}

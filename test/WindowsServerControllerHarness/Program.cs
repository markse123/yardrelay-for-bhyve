using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using BHyveControllerApp.Models;
using BHyveControllerApp.Services;

var appToken = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
var orbitPassword = Convert.ToHexString(RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
var artifactRoot = Path.Combine(Path.GetTempPath(), $"bhyve-windows-auth-{Guid.NewGuid():N}");
Directory.CreateDirectory(artifactRoot);

try
{
    VerifyServiceIdentityFixedVectors();
    VerifyWriteAccessSettings();
    VerifyHelpExternalLinkAllowlist();
    await VerifyUntrustedListenerIsRejectedAsync();
    await VerifyCrossPortIdentityProofIsRejectedAsync();
    await VerifyAuthenticatedControllerStillWorksAsync();
    await VerifyMutableInputsCannotRetargetVerifiedTrustAsync();
    await VerifyExternalListenerLossRevokesTrustAsync();
    await VerifyStartupRetryExhaustionFailsClosedAsync();
    Console.WriteLine("RESULT=PASS");
}

finally
{
    Directory.Delete(artifactRoot, recursive: true);
}

void VerifyServiceIdentityFixedVectors()
{
    const string token = "synthetic-test-token-that-is-not-a-credential";
    const string challenge = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const string origin = "http://127.0.0.1:3030";
    if (ServiceIdentity.ProtocolVersion != 2
        || ServiceIdentity.CreateProof(token, challenge, ServiceIdentity.IdentityPurpose, origin)
            != "kif3JIWzuxAv7He_GVysl3wDH0g3xmDttSW4J81JeQg"
        || ServiceIdentity.CreateProof(token, challenge, ServiceIdentity.ShutdownPurpose, origin)
            != "FNefke_xyoloN7WYWhxcbs3FK02GH69G7MPYF31vX-Q")
    {
        throw new InvalidOperationException("The Windows service-identity implementation drifted from protocol v2.");
    }
}

void VerifyWriteAccessSettings()
{
    var settings = new DesktopSettings();
    if (settings.RequireWriteToken || settings.WriteAccessMode != "local")
    {
        throw new InvalidOperationException("Desktop controls did not default to prompt-free local mode.");
    }

    settings.RequireWriteToken = true;
    if (settings.WriteAccessMode != "protected")
    {
        throw new InvalidOperationException("Desktop extra-security setting did not select protected mode.");
    }

    settings.DataDir = "data";
    settings.YardRunConfigPath = "config/yard-runs.local.json";
    settings.Host = "localhost";
    if (settings.IsComplete())
    {
        throw new InvalidOperationException("Desktop settings accepted a loopback alias outside the endpoint-bound identity protocol.");
    }
    AssertThrows<ArgumentException>(
        () => ServiceIdentity.CreateLoopbackOrigin(settings.Host, settings.Port),
        "origin is invalid");
}

static void AssertThrows<T>(Action action, string expectedMessage) where T : Exception
{
    try
    {
        action();
    }
    catch (T error) when (error.Message.Contains(expectedMessage, StringComparison.OrdinalIgnoreCase))
    {
        return;
    }
    throw new InvalidOperationException($"Expected {typeof(T).Name} containing {expectedMessage}.");
}

void VerifyHelpExternalLinkAllowlist()
{
    var approved = new[]
    {
        "https://nodejs.org/en/download",
        "https://developer.microsoft.com/en-us/microsoft-edge/webview2/",
    };
    if (approved.Any(url => !DesktopLinks.IsAllowedExternalUrl(url)))
    {
        throw new InvalidOperationException("An approved help destination was rejected.");
    }

    var rejected = new[]
    {
        "http://nodejs.org/en/download",
        "https://nodejs.org.attacker.invalid/",
        "https://user@github.com/markse123/bHyve-controller/releases",
        "file:///tmp/help.html",
    };
    if (rejected.Any(DesktopLinks.IsAllowedExternalUrl))
    {
        throw new InvalidOperationException("The help destination allowlist accepted an untrusted URL.");
    }
}

async Task VerifyUntrustedListenerIsRejectedAsync()
{
    await using var fake = new FakeController(appToken, authenticated: false);
    fake.Start();
    using var controller = CreateController(fake.Port);

    await AssertThrowsAsync<InvalidOperationException>(
        () => controller.StartAsync("/must/not/run", Settings(fake.Port), Secrets()),
        "could not authenticate");

    if (fake.CapturedTokens.Count != 0 || fake.Requests.Any(request => request.StartsWith("POST ", StringComparison.Ordinal)))
    {
        throw new InvalidOperationException("An untrusted listener received a token-bearing request.");
    }
    if (controller.ControllerBrowserUri is not null)
    {
        throw new InvalidOperationException("An untrusted listener received a browser URL containing the token.");
    }
}

async Task VerifyAuthenticatedControllerStillWorksAsync()
{
    await using var fake = new FakeController(appToken, authenticated: true);
    fake.Start();
    using var controller = CreateController(fake.Port);
    var trustRevocations = 0;
    controller.TrustRevoked += () => trustRevocations += 1;

    await controller.StartAsync("/must/not/run", Settings(fake.Port), Secrets());
    if (controller.IsManagedRunning)
    {
        throw new InvalidOperationException("The authenticated external-controller branch unexpectedly started a child.");
    }
    if (controller.ControllerBrowserUri?.Fragment != $"#token={appToken}")
    {
        throw new InvalidOperationException("The authenticated browser URL did not receive the token fragment.");
    }
    if (!controller.IsControllerNavigationUri(new Uri($"http://127.0.0.1:{fake.Port}/api/state"))
        || controller.IsControllerNavigationUri(new Uri($"https://127.0.0.1:{fake.Port}/"))
        || controller.IsControllerNavigationUri(new Uri($"http://example.invalid:{fake.Port}/"))
        || controller.IsControllerNavigationUri(new Uri($"http://user@127.0.0.1:{fake.Port}/")))
    {
        throw new InvalidOperationException("The controller browser navigation allowlist accepted an untrusted origin.");
    }

    await controller.StopAsync();
    if (trustRevocations != 1 || controller.ControllerBrowserUri is not null)
    {
        throw new InvalidOperationException("Stopping the controller did not revoke the token-bearing browser trust.");
    }
    if (fake.CapturedTokens.Count != 0)
    {
        throw new InvalidOperationException("The authenticated controller received the long-lived app token.");
    }
    if (!fake.ShutdownProofAccepted)
    {
        throw new InvalidOperationException("The authenticated controller did not receive a valid purpose-bound shutdown proof.");
    }
}

async Task VerifyCrossPortIdentityProofIsRejectedAsync()
{
    await using var fake = new FakeController(appToken, authenticated: true, signedOriginPort: 1);
    fake.Start();
    fake.SignedOriginPort = fake.Port == 65535 ? fake.Port - 1 : fake.Port + 1;
    using var controller = CreateController(fake.Port);

    await AssertThrowsAsync<InvalidOperationException>(
        () => controller.StartAsync("/must/not/run", Settings(fake.Port), Secrets()),
        "could not authenticate");
    if (controller.ControllerBrowserUri is not null)
    {
        throw new InvalidOperationException("A cross-port identity proof unlocked the browser token URI.");
    }
}

async Task VerifyMutableInputsCannotRetargetVerifiedTrustAsync()
{
    await using var fake = new FakeController(appToken, authenticated: true);
    fake.Start();
    using var controller = CreateController(fake.Port);
    var settings = Settings(fake.Port);
    var secrets = Secrets();

    await controller.StartAsync("/must/not/run", settings, secrets);
    var originalBrowserUri = controller.ControllerBrowserUri
        ?? throw new InvalidOperationException("The verified controller did not expose its browser URI.");
    var otherPort = fake.Port == 65535 ? fake.Port - 1 : fake.Port + 1;
    settings.Port = otherPort;
    secrets.AppToken = "mutated-synthetic-token-that-must-not-be-used";

    using var currentProcess = Process.GetCurrentProcess();
    SetPrivateField(controller, "_process", currentProcess);
    try
    {
        await controller.StartAsync("/must/not/run", settings, secrets);
        if (controller.ControllerBrowserUri != originalBrowserUri
            || controller.ControllerBrowserUri?.Port != fake.Port
            || controller.ControllerBrowserUri?.Fragment != $"#token={appToken}"
            || !controller.IsControllerNavigationUri(new Uri($"http://127.0.0.1:{fake.Port}/api/state"))
            || controller.IsControllerNavigationUri(new Uri($"http://127.0.0.1:{otherPort}/api/state")))
        {
            throw new InvalidOperationException("Mutable setup objects retargeted an already verified controller trust boundary.");
        }
    }
    finally
    {
        SetPrivateField<Process?>(controller, "_process", null);
    }

    await controller.StopAsync();
}

async Task VerifyExternalListenerLossRevokesTrustAsync()
{
    await using var fake = new FakeController(appToken, authenticated: true);
    fake.Start();
    using var controller = CreateController(
        fake.Port,
        identityMonitorInterval: TimeSpan.FromMilliseconds(10));
    var revoked = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    controller.TrustRevoked += () => revoked.TrySetResult();

    await controller.StartAsync("/must/not/run", Settings(fake.Port), Secrets());
    await fake.StopAsync();
    var completed = await Task.WhenAny(revoked.Task, Task.Delay(TimeSpan.FromSeconds(5)));
    if (completed != revoked.Task
        || controller.ControllerBrowserUri is not null
        || controller.IsControllerNavigationUri(new Uri($"http://127.0.0.1:{fake.Port}/api/state")))
    {
        throw new InvalidOperationException("Loss of an authenticated external controller did not promptly revoke browser trust.");
    }
}

async Task VerifyStartupRetryExhaustionFailsClosedAsync()
{
    var port = GetUnusedLoopbackPort();
    using var controller = CreateController(port, startupProbeAttempts: 1, startupProbeDelay: TimeSpan.Zero);
    var waitMethod = typeof(ServerController).GetMethod(
        "WaitUntilReachableAsync",
        System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)
        ?? throw new InvalidOperationException("Startup wait helper was not found.");
    var waitTask = (Task)(waitMethod.Invoke(controller, [Settings(port), Secrets(), CancellationToken.None])
        ?? throw new InvalidOperationException("Startup wait helper did not return a task."));

    await AssertThrowsAsync<TimeoutException>(async () => await waitTask, "did not become reachable");
    if (controller.ControllerBrowserUri is not null)
    {
        throw new InvalidOperationException("Retry exhaustion exposed the token-bearing browser URI.");
    }
}

ServerController CreateController(
    int port,
    int startupProbeAttempts = 24,
    TimeSpan? startupProbeDelay = null,
    TimeSpan? identityMonitorInterval = null)
{
    var paths = new DesktopPaths(Path.Combine(artifactRoot, port.ToString()));
    return new ServerController(
        paths,
        new AppLogger(),
        startupProbeAttempts,
        startupProbeDelay,
        identityMonitorInterval);
}

static void SetPrivateField<T>(ServerController controller, string name, T value)
{
    var field = typeof(ServerController).GetField(
        name,
        System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)
        ?? throw new InvalidOperationException($"ServerController field {name} was not found.");
    field.SetValue(controller, value);
}

static int GetUnusedLoopbackPort()
{
    var listener = new TcpListener(IPAddress.Loopback, 0);
    listener.Start();
    var port = ((IPEndPoint)listener.LocalEndpoint).Port;
    listener.Stop();
    return port;
}

DesktopSettings Settings(int port)
{
    var root = Path.Combine(artifactRoot, port.ToString());
    return new DesktopSettings
    {
        Host = "127.0.0.1",
        Port = port,
        DataDir = Path.Combine(root, "data"),
        YardRunConfigPath = Path.Combine(root, "config", "yard-runs.local.json"),
    };
}

DesktopSecrets Secrets() => new()
{
    OrbitEmail = "validation@example.invalid",
    OrbitPassword = orbitPassword,
    AppToken = appToken,
};

static async Task AssertThrowsAsync<T>(Func<Task> action, string expectedMessage) where T : Exception
{
    try
    {
        await action();
    }
    catch (T error) when (error.Message.Contains(expectedMessage, StringComparison.OrdinalIgnoreCase))
    {
        return;
    }
    throw new InvalidOperationException($"Expected {typeof(T).Name} containing {expectedMessage}.");
}

sealed class FakeController : IAsyncDisposable
{
    private readonly string _appToken;
    private readonly bool _authenticated;
    private readonly TcpListener _listener = new(IPAddress.Loopback, 0);
    private readonly CancellationTokenSource _stop = new();
    private Task? _serverTask;
    private string? _lastChallenge;
    private bool _stopped;

    public FakeController(string appToken, bool authenticated, int? signedOriginPort = null)
    {
        _appToken = appToken;
        _authenticated = authenticated;
        SignedOriginPort = signedOriginPort;
    }

    public int Port => ((IPEndPoint)_listener.LocalEndpoint).Port;
    public List<string> Requests { get; } = [];
    public List<string> CapturedTokens { get; } = [];
    public bool ShutdownProofAccepted { get; private set; }
    public int? SignedOriginPort { get; set; }

    public void Start()
    {
        _listener.Start();
        _serverTask = ServeAsync();
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync();
        _stop.Dispose();
    }

    public async Task StopAsync()
    {
        if (_stopped) return;
        _stopped = true;
        _stop.Cancel();
        _listener.Stop();
        if (_serverTask is not null)
        {
            try { await _serverTask; } catch (OperationCanceledException) { } catch (SocketException) { }
        }
    }

    private async Task ServeAsync()
    {
        while (!_stop.IsCancellationRequested)
        {
            using var client = await _listener.AcceptTcpClientAsync(_stop.Token);
            await HandleAsync(client, _stop.Token);
        }
    }

    private async Task HandleAsync(TcpClient client, CancellationToken cancellationToken)
    {
        await using var stream = client.GetStream();
        using var reader = new StreamReader(stream, Encoding.ASCII, leaveOpen: true);
        var requestLine = await reader.ReadLineAsync(cancellationToken) ?? string.Empty;
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        while (true)
        {
            var line = await reader.ReadLineAsync(cancellationToken);
            if (string.IsNullOrEmpty(line)) break;
            var separator = line.IndexOf(':');
            if (separator > 0) headers[line[..separator].Trim()] = line[(separator + 1)..].Trim();
        }

        Requests.Add(requestLine);
        if (requestLine.StartsWith("POST /api/shutdown ", StringComparison.Ordinal)
            && headers.TryGetValue("X-App-Token", out var captured))
        {
            CapturedTokens.Add(captured);
        }

        if (_authenticated && requestLine.StartsWith("GET /api/identity?", StringComparison.Ordinal))
        {
            var challenge = QueryValue(requestLine, "challenge")
                ?? throw new InvalidOperationException("Identity request omitted its challenge.");
            _lastChallenge = challenge;
            var origin = ServiceIdentity.CreateLoopbackOrigin("127.0.0.1", SignedOriginPort ?? Port);
            var body = JsonSerializer.SerializeToUtf8Bytes(new
            {
                service = ServiceIdentity.ServiceName,
                protocolVersion = ServiceIdentity.ProtocolVersion,
                challenge,
                origin,
                proof = ServiceIdentity.CreateProof(
                    _appToken,
                    challenge,
                    ServiceIdentity.IdentityPurpose,
                    origin),
            });
            await WriteResponseAsync(stream, "200 OK", "application/json", body, cancellationToken);
            return;
        }

        if (_authenticated && requestLine.StartsWith("POST /api/shutdown ", StringComparison.Ordinal))
        {
            var accepted = _lastChallenge is not null
                && SignedOriginPort is null
                && headers.TryGetValue("X-Controller-Challenge", out var shutdownChallenge)
                && string.Equals(shutdownChallenge, _lastChallenge, StringComparison.Ordinal)
                && headers.TryGetValue("X-Controller-Proof", out var shutdownProof)
                && ServiceIdentity.VerifyProof(
                    _appToken,
                    shutdownChallenge,
                    ServiceIdentity.ShutdownPurpose,
                    ServiceIdentity.CreateLoopbackOrigin("127.0.0.1", Port),
                    shutdownProof);
            ShutdownProofAccepted = accepted;
            await WriteResponseAsync(
                stream,
                accepted ? "202 Accepted" : "403 Forbidden",
                "application/json",
                "{}"u8.ToArray(),
                cancellationToken);
            return;
        }

        await WriteResponseAsync(stream, "404 Not Found", "text/plain", [], cancellationToken);
    }

    private static string? QueryValue(string requestLine, string key)
    {
        var target = requestLine.Split(' ', StringSplitOptions.RemoveEmptyEntries).ElementAtOrDefault(1);
        if (target is null) return null;
        var uri = new Uri($"http://127.0.0.1{target}");
        foreach (var pair in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = pair.Split('=', 2);
            if (Uri.UnescapeDataString(parts[0]) == key)
            {
                return parts.Length == 2 ? Uri.UnescapeDataString(parts[1]) : string.Empty;
            }
        }
        return null;
    }

    private static async Task WriteResponseAsync(
        NetworkStream stream,
        string status,
        string contentType,
        byte[] body,
        CancellationToken cancellationToken)
    {
        var headers = Encoding.ASCII.GetBytes(
            $"HTTP/1.1 {status}\r\nContent-Type: {contentType}\r\nContent-Length: {body.Length}\r\nConnection: close\r\n\r\n");
        await stream.WriteAsync(headers, cancellationToken);
        if (body.Length > 0)
        {
            await stream.WriteAsync(body, cancellationToken);
        }
    }
}

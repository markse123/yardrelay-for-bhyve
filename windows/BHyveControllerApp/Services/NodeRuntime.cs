using System.Diagnostics;
using System.Text.Json;
using BHyveControllerApp.Models;

namespace BHyveControllerApp.Services;

public sealed record NodeCheck(bool IsUsable, string? Path, string? Version, string Message);

public sealed record OrbitValidationResult(bool Ok, int DeviceCount, int ZoneCount, int ProgramCount, string? Error)
{
    public string Summary => Ok
        ? $"Connected to Orbit. Found {DeviceCount} controller(s), {ZoneCount} zone(s), {ProgramCount} program(s)."
        : $"Orbit login validation failed: {Error}";
}

public sealed class NodeRuntime
{
    public NodeCheck FindUsableNode(string? overridePath)
    {
        foreach (var candidate in CandidatePaths(overridePath))
        {
            var check = CheckNode(candidate);
            if (check.IsUsable)
            {
                return check;
            }
        }

        return new NodeCheck(false, null, null, "Node.js 24 or newer was not found.");
    }

    public async Task<OrbitValidationResult> ValidateOrbitLoginAsync(
        string nodePath,
        string serverRoot,
        DesktopSecrets secrets,
        CancellationToken cancellationToken)
    {
        var scriptPath = Path.Combine(serverRoot, "scripts", "validate-orbit-login.mjs");
        if (!File.Exists(scriptPath))
        {
            return new OrbitValidationResult(false, 0, 0, 0, "Validation script was not found in the app package.");
        }

        var startInfo = new ProcessStartInfo(nodePath)
        {
            WorkingDirectory = serverRoot,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        AddBaseEnvironment(startInfo);
        startInfo.ArgumentList.Add(scriptPath);
        startInfo.ArgumentList.Add("--json");
        startInfo.Environment["ORBIT_EMAIL"] = secrets.OrbitEmail;
        startInfo.Environment["ORBIT_PASSWORD"] = secrets.OrbitPassword;

        using var process = Process.Start(startInfo);
        if (process is null)
        {
            return new OrbitValidationResult(false, 0, 0, 0, "Could not start Node.js.");
        }

        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(45));
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeout.Token);
        try
        {
            var stdoutTask = process.StandardOutput.ReadToEndAsync(linked.Token);
            var stderrTask = process.StandardError.ReadToEndAsync(linked.Token);
            await process.WaitForExitAsync(linked.Token);
            var stdout = await stdoutTask;
            var stderr = await stderrTask;
            var line = stdout.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries).LastOrDefault();
            if (line is not null)
            {
                var parsed = JsonSerializer.Deserialize<ValidationJson>(line, new JsonSerializerOptions(JsonSerializerDefaults.Web));
                if (parsed is not null)
                {
                    return new OrbitValidationResult(
                        parsed.Ok,
                        parsed.DeviceCount,
                        parsed.ZoneCount,
                        parsed.ProgramCount,
                        parsed.Error ?? Redactor.ForLog(stderr));
                }
            }

            return new OrbitValidationResult(false, 0, 0, 0, Redactor.ForLog(stderr.Length > 0 ? stderr : "Unexpected validation output."));
        }
        catch (OperationCanceledException)
        {
            TryKill(process);
            return new OrbitValidationResult(false, 0, 0, 0, "Validation timed out.");
        }
    }

    private NodeCheck CheckNode(string path)
    {
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
        {
            return new NodeCheck(false, path, null, "Node executable does not exist.");
        }

        try
        {
            var startInfo = new ProcessStartInfo(path)
            {
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            startInfo.ArgumentList.Add("--version");
            using var process = Process.Start(startInfo);
            if (process is null)
            {
                return new NodeCheck(false, path, null, "Could not start Node.js.");
            }

            if (!process.WaitForExit(5000))
            {
                TryKill(process);
                return new NodeCheck(false, path, null, "Node version check timed out.");
            }

            var version = process.StandardOutput.ReadToEnd().Trim();
            var major = ParseMajorVersion(version);
            return major >= 24
                ? new NodeCheck(true, path, version, $"Node {version} found.")
                : new NodeCheck(false, path, version, $"Node {version} found, but Node.js 24 or newer is required.");
        }
        catch (Exception error)
        {
            return new NodeCheck(false, path, null, Redactor.ForLog(error.Message));
        }
    }

    private static IEnumerable<string> CandidatePaths(string? overridePath)
    {
        if (!string.IsNullOrWhiteSpace(overridePath))
        {
            yield return overridePath;
        }

        var pathValue = Environment.GetEnvironmentVariable("PATH") ?? string.Empty;
        foreach (var directory in pathValue.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            yield return System.IO.Path.Combine(directory.Trim(), "node.exe");
        }

        var programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        var programFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
        if (!string.IsNullOrWhiteSpace(programFiles))
        {
            yield return System.IO.Path.Combine(programFiles, "nodejs", "node.exe");
        }
        if (!string.IsNullOrWhiteSpace(programFilesX86))
        {
            yield return System.IO.Path.Combine(programFilesX86, "nodejs", "node.exe");
        }
    }

    private static int ParseMajorVersion(string version)
    {
        var trimmed = version.Trim().TrimStart('v', 'V');
        var major = trimmed.Split('.').FirstOrDefault();
        return int.TryParse(major, out var value) ? value : 0;
    }

    private static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited)
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

    private sealed class ValidationJson
    {
        public bool Ok { get; set; }
        public int DeviceCount { get; set; }
        public int ZoneCount { get; set; }
        public int ProgramCount { get; set; }
        public string? Error { get; set; }
    }
}

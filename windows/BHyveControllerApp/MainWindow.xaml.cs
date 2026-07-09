using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Threading;
using BHyveControllerApp.Models;
using BHyveControllerApp.Services;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;

namespace BHyveControllerApp;

public partial class MainWindow : Window
{
    private readonly DesktopPaths _paths;
    private readonly SettingsStore _settingsStore;
    private readonly SecretStore _secretStore;
    private readonly NodeRuntime _nodeRuntime = new();
    private readonly AppLogger _logger;
    private readonly ServerController _server;
    private DesktopSettings _settings;
    private DesktopSecrets _secrets;
    private NodeCheck _nodeCheck;
    private string? _importedAppToken;
    private bool _rejectedUnsafeStoredAppToken;
    private bool _pendingUnsafeImportTokenReplacement;
    private bool _setupVisible;
    private bool _webViewSecurityConfigured;
    private bool _closeInProgress;
    private bool _closeReady;
    private HelpWindow? _helpWindow;

    internal MainWindow(DesktopPaths paths)
    {
        _paths = paths ?? throw new ArgumentNullException(nameof(paths));
        InitializeComponent();
        _settingsStore = new SettingsStore(_paths);
        _secretStore = new SecretStore(_paths);
        _logger = new AppLogger(_paths);
        _settings = _settingsStore.LoadOrDefault();
        _secrets = SafeLoadSecrets();
        _nodeCheck = _nodeRuntime.FindUsableNode(_settings.NodePath);
        _server = new ServerController(_paths, _logger);
        _server.MessageChanged += Server_MessageChanged;
        _server.TrustRevoked += Server_TrustRevoked;
        Loaded += MainWindow_Loaded;
    }

    private async void MainWindow_Loaded(object sender, RoutedEventArgs e)
    {
        ApplySettingsToForm();
        RefreshNodeStatus();
        if (!_settings.IsComplete() || !_secrets.IsComplete())
        {
            ShowSetup(_rejectedUnsafeStoredAppToken
                ? "YardRelay rejected an unsafe saved app token. Before Save, stop watering and physically verify sprinkler state. Saving creates a new token and old signed yard-run recovery becomes unusable."
                : "Complete setup to start the controller.");
            return;
        }

        await StartControllerAsync();
    }

    private async Task StartControllerAsync()
    {
        _nodeCheck = _nodeRuntime.FindUsableNode(_settings.NodePath);
        RefreshNodeStatus();
        if (!_nodeCheck.IsUsable || _nodeCheck.Path is null)
        {
            ShowSetup(_nodeCheck.Message);
            return;
        }

        HideSetup();
        try
        {
            await _server.StartAsync(_nodeCheck.Path, _settings, _secrets);
            await LoadWebViewAsync();
        }
        catch (Exception error)
        {
            _logger.Warn($"start failed: {error.Message}");
            ShowSetup(Redactor.ForLog(error.Message));
        }
    }

    private async Task LoadWebViewAsync()
    {
        if (_server.ControllerBrowserUri is null)
        {
            return;
        }

        try
        {
            await ControllerWebView.EnsureCoreWebView2Async();
            ConfigureWebViewSecurity();
            ControllerWebView.Visibility = Visibility.Visible;
            ControllerWebView.Source = _server.ControllerBrowserUri;
        }
        catch (Exception error)
        {
            ShowSetup($"WebView2 is unavailable: {Redactor.ForLog(error.Message)}");
        }
    }

    private void ConfigureWebViewSecurity()
    {
        if (_webViewSecurityConfigured || ControllerWebView.CoreWebView2 is null)
        {
            return;
        }

        ControllerWebView.NavigationStarting += ControllerWebView_NavigationStarting;
        ControllerWebView.CoreWebView2.FrameNavigationStarting += ControllerWebView_FrameNavigationStarting;
        ControllerWebView.CoreWebView2.NewWindowRequested += ControllerWebView_NewWindowRequested;
        _webViewSecurityConfigured = true;
    }

    private void ControllerWebView_NavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs args)
    {
        args.Cancel = !IsAllowedControllerNavigation(args.Uri);
    }

    private void ControllerWebView_FrameNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs args)
    {
        args.Cancel = !IsAllowedControllerNavigation(args.Uri);
    }

    private static void ControllerWebView_NewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs args)
    {
        args.Handled = true;
        DesktopLinks.OpenAllowedExternalUrl(args.Uri);
    }

    private bool IsAllowedControllerNavigation(string? value)
    {
        return string.Equals(value, "about:blank", StringComparison.OrdinalIgnoreCase)
            || (Uri.TryCreate(value, UriKind.Absolute, out var candidate)
                && _server.IsControllerNavigationUri(candidate));
    }

    private void Server_MessageChanged(string message)
    {
        Dispatcher.BeginInvoke(() => SetStatus(message));
    }

    private void Server_TrustRevoked()
    {
        Dispatcher.BeginInvoke(DispatcherPriority.Send, new Action(RevokeControllerWebViewTrust));
    }

    private void RevokeControllerWebViewTrust()
    {
        ReloadButton.IsEnabled = false;
        ControllerWebView.Visibility = Visibility.Collapsed;
        if (ControllerWebView.CoreWebView2 is not null)
        {
            ControllerWebView.CoreWebView2.Stop();
            ControllerWebView.CoreWebView2.Navigate("about:blank");
        }
        else
        {
            ControllerWebView.Source = new Uri("about:blank");
        }
    }

    private DesktopSecrets SafeLoadSecrets()
    {
        try
        {
            var secrets = _secretStore.LoadOrDefault(out _rejectedUnsafeStoredAppToken);
            if (_rejectedUnsafeStoredAppToken)
            {
                _logger.Warn("rejected an unsafe stored app token; setup must generate a replacement");
            }
            return secrets;
        }
        catch (Exception error)
        {
            _logger.Warn($"could not load secrets: {error.Message}");
            return new DesktopSecrets();
        }
    }

    private void ApplySettingsToForm()
    {
        EmailBox.Text = _secrets.OrbitEmail;
        PasswordBox.Password = _secrets.OrbitPassword;
        PortBox.Text = _settings.Port.ToString();
        NodePathBox.Text = _settings.NodePath ?? string.Empty;
        RequireWriteTokenBox.IsChecked = _settings.RequireWriteToken;
    }

    private void CaptureFormValues()
    {
        _settings.Host = "127.0.0.1";
        _settings.Port = int.TryParse(PortBox.Text.Trim(), out var port) ? port : 0;
        _settings.NodePath = string.IsNullOrWhiteSpace(NodePathBox.Text) ? null : NodePathBox.Text.Trim();
        _settings.DataDir = string.IsNullOrWhiteSpace(_settings.DataDir) ? _paths.DataDir : _settings.DataDir;
        _settings.YardRunConfigPath = string.IsNullOrWhiteSpace(_settings.YardRunConfigPath)
            ? _paths.YardRunConfigPath
            : _settings.YardRunConfigPath;
        _settings.RequireWriteToken = RequireWriteTokenBox.IsChecked == true;
        _secrets.OrbitEmail = EmailBox.Text.Trim();
        _secrets.OrbitPassword = PasswordBox.Password;
        if (!AppTokenPolicy.TryNormalize(_secrets.AppToken, out var appToken))
        {
            appToken = AppTokenPolicy.NormalizeOrGenerate(_importedAppToken, out _);
        }
        _secrets.AppToken = appToken;
        _importedAppToken = null;
    }

    private bool ValidateForm()
    {
        if (string.IsNullOrWhiteSpace(EmailBox.Text))
        {
            SetSetupMessage("Enter your Orbit email.");
            return false;
        }
        if (string.IsNullOrWhiteSpace(PasswordBox.Password))
        {
            SetSetupMessage("Enter your Orbit password.");
            return false;
        }
        if (!int.TryParse(PortBox.Text.Trim(), out var port) || port is < 1024 or > 65535)
        {
            SetSetupMessage("Enter a port from 1024 to 65535.");
            return false;
        }
        return true;
    }

    private void ShowSetup(string message)
    {
        _setupVisible = true;
        ControllerPanel.Visibility = Visibility.Collapsed;
        SetupPanel.Visibility = Visibility.Visible;
        ApplySettingsToForm();
        RefreshNodeStatus();
        SetSetupMessage(message);
    }

    private void HideSetup()
    {
        _setupVisible = false;
        SetupPanel.Visibility = Visibility.Collapsed;
        ControllerPanel.Visibility = Visibility.Visible;
    }

    private void SetStatus(string message)
    {
        StatusText.Text = message;
        StartButton.IsEnabled = !_server.IsManagedRunning;
        StopButton.IsEnabled = _server.IsManagedRunning;
        RestartButton.IsEnabled = _settings.IsComplete() && _secrets.IsComplete();
        ReloadButton.IsEnabled = !_setupVisible && _server.ControllerBrowserUri is not null;
    }

    private void SetSetupMessage(string message)
    {
        SetupMessageText.Text = message;
        SetStatus(message);
    }

    private void RefreshNodeStatus()
    {
        _nodeCheck = _nodeRuntime.FindUsableNode(string.IsNullOrWhiteSpace(NodePathBox.Text) ? _settings.NodePath : NodePathBox.Text.Trim());
        NodeStatusText.Text = _nodeCheck.Message;
    }

    private async void StartButton_Click(object sender, RoutedEventArgs e)
    {
        await StartControllerAsync();
    }

    private async void StopButton_Click(object sender, RoutedEventArgs e)
    {
        await _server.StopAsync();
    }

    private async void RestartButton_Click(object sender, RoutedEventArgs e)
    {
        await RestartControllerAsync();
    }

    private async Task RestartControllerAsync()
    {
        RefreshNodeStatus();
        if (_nodeCheck.Path is null)
        {
            ShowSetup("Node.js 24 or newer is required.");
            return;
        }
        try
        {
            await _server.RestartAsync(_nodeCheck.Path, _settings, _secrets);
            await LoadWebViewAsync();
        }
        catch (Exception error)
        {
            var safeMessage = Redactor.ForLog(error.Message);
            _logger.Warn($"restart failed: {safeMessage}");
            ShowSetup(safeMessage);
        }
    }

    private void ReloadButton_Click(object sender, RoutedEventArgs e)
    {
        ControllerWebView.Reload();
    }

    private void SettingsButton_Click(object sender, RoutedEventArgs e)
    {
        ShowSetup("Update settings, then save to restart the controller.");
    }

    private void HelpButton_Click(object sender, RoutedEventArgs e)
    {
        if (_helpWindow is not null)
        {
            _helpWindow.Activate();
            return;
        }

        _helpWindow = new HelpWindow(_paths.HelpPath)
        {
            Owner = this,
        };
        _helpWindow.Closed += (_, _) => _helpWindow = null;
        _helpWindow.Show();
    }

    private void OpenConfigButton_Click(object sender, RoutedEventArgs e)
    {
        OpenFolder(_paths.ConfigDir);
    }

    private void OpenDataButton_Click(object sender, RoutedEventArgs e)
    {
        OpenFolder(_paths.AppDataDir);
    }

    private void DownloadNodeButton_Click(object sender, RoutedEventArgs e)
    {
        OpenUrl("https://nodejs.org/en/download");
    }

    private void DownloadWebViewButton_Click(object sender, RoutedEventArgs e)
    {
        OpenUrl("https://developer.microsoft.com/en-us/microsoft-edge/webview2/");
    }

    private void BrowseNodeButton_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFileDialog
        {
            Title = "Choose node.exe",
            Filter = "Node.js (node.exe)|node.exe|Executables (*.exe)|*.exe|All files (*.*)|*.*",
        };
        if (dialog.ShowDialog(this) == true)
        {
            NodePathBox.Text = dialog.FileName;
            RefreshNodeStatus();
        }
    }

    private void ImportEnvButton_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFileDialog
        {
            Title = "Import .env",
            Filter = "Environment files (.env*)|.env*|All files (*.*)|*.*",
        };
        if (dialog.ShowDialog(this) != true)
        {
            return;
        }

        var values = EnvFileParser.Parse(dialog.FileName);
        if (values.TryGetValue("ORBIT_EMAIL", out var email))
        {
            EmailBox.Text = email;
        }
        if (values.TryGetValue("ORBIT_PASSWORD", out var password))
        {
            PasswordBox.Password = password;
        }
        if (values.TryGetValue("PORT", out var port))
        {
            PortBox.Text = port;
        }
        var replacedUnsafeAppToken = false;
        if (values.TryGetValue("APP_TOKEN", out var appToken))
        {
            _importedAppToken = AppTokenPolicy.NormalizeOrGenerate(appToken, out replacedUnsafeAppToken);
        }
        else
        {
            _importedAppToken = AppTokenPolicy.GenerateAppToken();
        }
        if (values.TryGetValue("WRITE_ACCESS_MODE", out var writeAccessMode))
        {
            RequireWriteTokenBox.IsChecked = string.Equals(writeAccessMode, "protected", StringComparison.OrdinalIgnoreCase);
        }
        var hasExistingSafeAppToken = AppTokenPolicy.TryNormalize(_secrets.AppToken, out _);
        _pendingUnsafeImportTokenReplacement = replacedUnsafeAppToken && !hasExistingSafeAppToken;
        SetSetupMessage(replacedUnsafeAppToken
            ? hasExistingSafeAppToken
                ? "Imported .env values. The unsafe APP_TOKEN was ignored; the existing safe token will be retained."
                : "Imported .env values. The unsafe APP_TOKEN was ignored and a fresh token will be generated. Before Save, stop watering and physically verify sprinkler state because old signed yard-run recovery becomes unusable."
            : "Imported .env values. Save setup to store them for this Windows user.");
    }

    private void ImportYardRunButton_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFileDialog
        {
            Title = "Import yard-run config",
            Filter = "JSON files (*.json)|*.json|All files (*.*)|*.*",
        };
        if (dialog.ShowDialog(this) != true)
        {
            return;
        }

        _paths.EnsureUserDirectories();
        Directory.CreateDirectory(Path.GetDirectoryName(_settings.YardRunConfigPath) ?? _paths.ConfigDir);
        File.Copy(dialog.FileName, _settings.YardRunConfigPath, overwrite: true);
        SetSetupMessage($"Copied yard-run config to {_settings.YardRunConfigPath}.");
    }

    private async void TestLoginButton_Click(object sender, RoutedEventArgs e)
    {
        if (!ValidateForm())
        {
            return;
        }

        CaptureFormValues();
        RefreshNodeStatus();
        if (!_nodeCheck.IsUsable || _nodeCheck.Path is null)
        {
            SetSetupMessage(_nodeCheck.Message);
            return;
        }

        SetSetupMessage("Testing Orbit login...");
        var result = await _nodeRuntime.ValidateOrbitLoginAsync(_nodeCheck.Path, _paths.ServerRoot, _secrets, CancellationToken.None);
        SetSetupMessage(result.Summary);
    }

    private async void SaveSetupButton_Click(object sender, RoutedEventArgs e)
    {
        if (!ValidateForm())
        {
            return;
        }

        if ((_rejectedUnsafeStoredAppToken || _pendingUnsafeImportTokenReplacement)
            && MessageBox.Show(
                this,
                "Saving will replace the app token and make old signed yard-run recovery unusable. Stop watering and physically verify sprinkler state before continuing. Save setup now?",
                "Confirm app-token replacement",
                MessageBoxButton.YesNo,
                MessageBoxImage.Warning) != MessageBoxResult.Yes)
        {
            return;
        }

        var shouldRestart = _server.IsManagedRunning || _server.ControllerBrowserUri is not null;
        CaptureFormValues();
        _paths.EnsureUserDirectories();
        _settingsStore.Save(_settings);
        _secretStore.Save(_secrets);
        _rejectedUnsafeStoredAppToken = false;
        _pendingUnsafeImportTokenReplacement = false;
        _logger.Info("saved desktop setup");
        SetSetupMessage(shouldRestart
            ? "Settings saved. Restarting the controller to apply changes..."
            : "Settings saved. Starting the controller...");
        if (shouldRestart)
        {
            await RestartControllerAsync();
        }
        else
        {
            await StartControllerAsync();
        }
    }

    private void CancelSetupButton_Click(object sender, RoutedEventArgs e)
    {
        if (_settings.IsComplete() && _secrets.IsComplete())
        {
            HideSetup();
        }
    }

    private async void ResetSetupButton_Click(object sender, RoutedEventArgs e)
    {
        var result = MessageBox.Show(
            this,
            "Reset settings and secrets for this Windows user? This replaces the app token, so old signed yard-run recovery becomes unusable. Stop watering and physically verify sprinkler state before continuing. Yard-run config, logs, and runtime data will be kept.",
            "Reset setup",
            MessageBoxButton.YesNo,
            MessageBoxImage.Warning);
        if (result != MessageBoxResult.Yes)
        {
            return;
        }

        await _server.StopAsync();
        _settingsStore.Delete();
        _secretStore.Delete();
        _settings = _settingsStore.CreateDefault();
        _secrets = new DesktopSecrets();
        _importedAppToken = null;
        _rejectedUnsafeStoredAppToken = false;
        _pendingUnsafeImportTokenReplacement = false;
        ApplySettingsToForm();
        ShowSetup("Setup was reset.");
    }

    private void CopyDiagnosticsButton_Click(object sender, RoutedEventArgs e)
    {
        CaptureFormValues();
        RefreshNodeStatus();
        Clipboard.SetText(DiagnosticsBuilder.Build(_paths, _settings, _secrets, _nodeCheck, _server, _logger));
        SetSetupMessage("Diagnostics copied to clipboard.");
    }

    protected override void OnClosing(CancelEventArgs e)
    {
        if (_closeReady)
        {
            base.OnClosing(e);
            return;
        }

        base.OnClosing(e);
        e.Cancel = true;
        if (_closeInProgress)
        {
            return;
        }

        _closeInProgress = true;
        IsEnabled = false;
        _ = CompleteCloseAsync();
    }

    private async Task CompleteCloseAsync()
    {
        try
        {
            await _server.StopAsync();
        }
        catch (Exception error)
        {
            _logger.Warn($"close cleanup failed: {Redactor.ForLog(error.Message)}");
        }
        finally
        {
            _server.MessageChanged -= Server_MessageChanged;
            _server.TrustRevoked -= Server_TrustRevoked;
            _server.Dispose();
            _closeReady = true;
            _closeInProgress = false;
            _ = Dispatcher.BeginInvoke(DispatcherPriority.Send, new Action(Close));
        }
    }

    private static void OpenFolder(string path)
    {
        Directory.CreateDirectory(path);
        Process.Start(new ProcessStartInfo("explorer.exe", $"\"{path}\"") { UseShellExecute = true });
    }

    private static void OpenUrl(string url)
    {
        Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
    }
}

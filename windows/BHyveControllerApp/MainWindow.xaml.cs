using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Windows;
using BHyveControllerApp.Models;
using BHyveControllerApp.Services;
using Microsoft.Web.WebView2.Core;
using Microsoft.Win32;

namespace BHyveControllerApp;

public partial class MainWindow : Window
{
    private readonly DesktopPaths _paths = new();
    private readonly SettingsStore _settingsStore;
    private readonly SecretStore _secretStore;
    private readonly NodeRuntime _nodeRuntime = new();
    private readonly AppLogger _logger;
    private readonly ServerController _server;
    private DesktopSettings _settings;
    private DesktopSecrets _secrets;
    private NodeCheck _nodeCheck;
    private string? _importedAppToken;
    private bool _setupVisible;
    private bool _webViewSecurityConfigured;
    private HelpWindow? _helpWindow;

    public MainWindow()
    {
        InitializeComponent();
        _settingsStore = new SettingsStore(_paths);
        _secretStore = new SecretStore(_paths);
        _logger = new AppLogger(_paths);
        _server = new ServerController(_paths, _logger);
        _server.MessageChanged += message => Dispatcher.Invoke(() => SetStatus(message));
        _settings = _settingsStore.LoadOrDefault();
        _secrets = SafeLoadSecrets();
        _nodeCheck = _nodeRuntime.FindUsableNode(_settings.NodePath);
        Loaded += MainWindow_Loaded;
    }

    private async void MainWindow_Loaded(object sender, RoutedEventArgs e)
    {
        ApplySettingsToForm();
        RefreshNodeStatus();
        if (!_settings.IsComplete() || !_secrets.IsComplete())
        {
            ShowSetup("Complete setup to start the controller.");
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
        return Uri.TryCreate(value, UriKind.Absolute, out var candidate)
            && _server.IsControllerNavigationUri(candidate);
    }

    private DesktopSecrets SafeLoadSecrets()
    {
        try
        {
            return _secretStore.LoadOrDefault();
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
        if (string.IsNullOrWhiteSpace(_secrets.AppToken))
        {
            _secrets.AppToken = _importedAppToken ?? SecretStore.GenerateAppToken();
        }
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
        ReloadButton.IsEnabled = !_setupVisible;
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
        if (_nodeCheck.Path is null)
        {
            ShowSetup("Node.js 24 or newer is required.");
            return;
        }
        await _server.RestartAsync(_nodeCheck.Path, _settings, _secrets);
        await LoadWebViewAsync();
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
        if (values.TryGetValue("APP_TOKEN", out var appToken) && !string.IsNullOrWhiteSpace(appToken))
        {
            _importedAppToken = appToken;
        }
        if (values.TryGetValue("WRITE_ACCESS_MODE", out var writeAccessMode))
        {
            RequireWriteTokenBox.IsChecked = string.Equals(writeAccessMode, "protected", StringComparison.OrdinalIgnoreCase);
        }
        SetSetupMessage("Imported .env values. Save setup to store them for this Windows user.");
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

        CaptureFormValues();
        _paths.EnsureUserDirectories();
        _settingsStore.Save(_settings);
        _secretStore.Save(_secrets);
        _logger.Info("saved desktop setup");
        await StartControllerAsync();
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
            "Reset settings and secrets for this Windows user? Yard-run config, logs, and runtime data will be kept.",
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

    protected override async void OnClosing(CancelEventArgs e)
    {
        await _server.StopAsync();
        _server.Dispose();
        base.OnClosing(e);
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

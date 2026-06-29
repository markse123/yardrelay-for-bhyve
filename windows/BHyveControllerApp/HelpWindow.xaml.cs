using System.IO;
using System.Windows;
using BHyveControllerApp.Services;
using Microsoft.Web.WebView2.Core;

namespace BHyveControllerApp;

public partial class HelpWindow : Window
{
    private readonly string _helpPath;

    public HelpWindow(string helpPath)
    {
        InitializeComponent();
        _helpPath = Path.GetFullPath(helpPath);
        Loaded += HelpWindow_Loaded;
    }

    private async void HelpWindow_Loaded(object sender, RoutedEventArgs e)
    {
        if (!File.Exists(_helpPath))
        {
            ShowMissingHelp($"The bundled user guide was not found at {_helpPath}.");
            return;
        }

        try
        {
            await HelpWebView.EnsureCoreWebView2Async();
            HelpWebView.NavigationStarting += HelpWebView_NavigationStarting;
            HelpWebView.CoreWebView2.NewWindowRequested += HelpWebView_NewWindowRequested;
            HelpWebView.Source = new Uri(_helpPath);
        }
        catch (Exception error)
        {
            ShowMissingHelp($"The user guide could not be opened: {Redactor.ForLog(error.Message)}");
        }
    }

    private void HelpWebView_NavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs args)
    {
        if (IsAllowedManualNavigation(args.Uri))
        {
            return;
        }

        args.Cancel = true;
        DesktopLinks.OpenAllowedExternalUrl(args.Uri);
    }

    private static void HelpWebView_NewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs args)
    {
        args.Handled = true;
        DesktopLinks.OpenAllowedExternalUrl(args.Uri);
    }

    private bool IsAllowedManualNavigation(string? value)
    {
        if (!Uri.TryCreate(value, UriKind.Absolute, out var candidate) || !candidate.IsFile)
        {
            return false;
        }

        var candidatePath = Path.GetFullPath(candidate.LocalPath);
        return string.Equals(candidatePath, _helpPath, StringComparison.OrdinalIgnoreCase);
    }

    private void ShowMissingHelp(string message)
    {
        HelpWebView.Visibility = Visibility.Collapsed;
        MissingHelpText.Text = message;
        MissingHelpPanel.Visibility = Visibility.Visible;
    }
}

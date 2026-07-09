using System.IO;
using System.Security;
using System.Text.Json;
using System.Windows;
using BHyveControllerApp.Services;

namespace BHyveControllerApp;

public partial class App : Application
{
    private const string StartupConfigurationFailureMessage =
        "YardRelay could not safely read its existing Windows app data, so startup was stopped. "
        + "The files in %LOCALAPPDATA%\\YardRelay were left unchanged. "
        + "Close YardRelay, make sure the folder is accessible and settings.json contains valid JSON, then try again. "
        + "Do not delete, reset, overwrite, or merge the folder. If the problem continues, preserve the folder and report the startup failure.";

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        if (!DesktopPaths.TryCreate(out var paths, out var failureMessage))
        {
            ShowStartupFailure(failureMessage);
            return;
        }

        MainWindow window;
        try
        {
            window = new MainWindow(paths);
        }
        catch (Exception error) when (error is IOException
            or UnauthorizedAccessException
            or InvalidDataException
            or JsonException
            or SecurityException)
        {
            ShowStartupFailure(StartupConfigurationFailureMessage);
            return;
        }

        MainWindow = window;
        window.Show();
    }

    private void ShowStartupFailure(string message)
    {
        MessageBox.Show(
            message,
            "YardRelay could not start",
            MessageBoxButton.OK,
            MessageBoxImage.Error);
        Shutdown(-1);
    }
}

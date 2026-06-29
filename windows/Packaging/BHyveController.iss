#define MyAppName "YardRelay"
#define MyAppExeName "YardRelayApp.exe"

#ifndef SourceDir
#error SourceDir must be provided with /DSourceDir=<publish directory>
#endif

#ifndef OutputDir
#define OutputDir "."
#endif

#ifndef AppVersion
#define AppVersion "0.2.0"
#endif

[Setup]
AppId={{A45E6D63-B6E8-4C45-8C89-2B967C071721}
AppName={#MyAppName}
AppVersion={#AppVersion}
AppPublisher=YardRelay contributors
DefaultDirName={localappdata}\Programs\YardRelay
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
OutputDir={#OutputDir}
OutputBaseFilename=YardRelaySetup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
PrivilegesRequired=lowest
MinVersion=10.0.22000
WizardStyle=modern
SetupLogging=yes
UninstallDisplayIcon={app}\{#MyAppExeName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch {#MyAppName}"; Flags: nowait postinstall skipifsilent

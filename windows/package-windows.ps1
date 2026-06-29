param(
    [ValidateSet("win-x64", "win-arm64")]
    [string]$Runtime = "win-x64",

    [string]$Configuration = "Release",

    [switch]$BuildInstaller
)

$ErrorActionPreference = "Stop"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ProjectPath = Join-Path $RepoRoot "windows/BHyveControllerApp/BHyveControllerApp.csproj"
$OutputRoot = Join-Path $RepoRoot "outputs/windows"
$PublishDir = Join-Path $OutputRoot "publish/$Runtime"
$ZipPath = Join-Path $OutputRoot "YardRelay-$Runtime.zip"
$PackageJson = Get-Content (Join-Path $RepoRoot "package.json") -Raw | ConvertFrom-Json
$AppVersion = $PackageJson.version

if ($PackageJson.name -ne "yardrelay-for-bhyve" -or $AppVersion -notmatch '^\d+\.\d+\.\d+$') {
    throw "package.json does not contain the expected YardRelay identity and a valid product version."
}

$node = Get-Command "node" -ErrorAction SilentlyContinue
if (-not $node) {
    throw "Node.js was not found. It is required to validate canonical product metadata before packaging."
}

& $node.Source (Join-Path $RepoRoot "scripts/sync-product-metadata.mjs") --check
if ($LASTEXITCODE -ne 0) {
    throw "Product metadata validation failed; packaging stopped."
}

function Find-DotnetCli {
    if ($env:DOTNET_EXE -and (Test-Path $env:DOTNET_EXE)) {
        return $env:DOTNET_EXE
    }

    $command = Get-Command "dotnet" -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    $candidatePaths = @(
        "/usr/local/share/dotnet/dotnet",
        "/opt/homebrew/bin/dotnet",
        "C:/Program Files/dotnet/dotnet.exe"
    )

    foreach ($candidate in $candidatePaths) {
        if ($candidate -and (Test-Path $candidate)) {
            return $candidate
        }
    }

    throw "dotnet was not found. Install the .NET SDK or set DOTNET_EXE to the full path of dotnet."
}

function Find-InnoCompiler {
    if ($env:ISCC -and (Test-Path $env:ISCC)) {
        return $env:ISCC
    }

    $command = Get-Command "iscc.exe" -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    $candidatePaths = @()
    if (${env:ProgramFiles(x86)}) {
        $candidatePaths += (Join-Path ${env:ProgramFiles(x86)} "Inno Setup 6/ISCC.exe")
    }
    if ($env:ProgramFiles) {
        $candidatePaths += (Join-Path $env:ProgramFiles "Inno Setup 6/ISCC.exe")
    }

    foreach ($candidate in $candidatePaths) {
        if ($candidate -and (Test-Path $candidate)) {
            return $candidate
        }
    }

    return $null
}

$dotnet = Find-DotnetCli

New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null
if (Test-Path $PublishDir) {
    Remove-Item $PublishDir -Recurse -Force
}
if (Test-Path $ZipPath) {
    Remove-Item $ZipPath -Force
}

$publishArgs = @(
    "publish",
    $ProjectPath,
    "-c", $Configuration,
    "-r", $Runtime,
    "--self-contained", "true",
    "-p:PublishSingleFile=false",
    "-o", $PublishDir
)

& $dotnet @publishArgs
if ($LASTEXITCODE -ne 0) {
    throw "dotnet publish failed with exit code $LASTEXITCODE; packaging stopped."
}

Compress-Archive -Path (Join-Path $PublishDir "*") -DestinationPath $ZipPath -Force
Write-Host "Created $ZipPath"

if ($BuildInstaller) {
    $iscc = Find-InnoCompiler
    if (-not $iscc) {
        throw "Inno Setup 6 compiler was not found. Install it or set ISCC to the full path of ISCC.exe."
    }

    $installerScript = Join-Path $RepoRoot "windows/Packaging/BHyveController.iss"
    & $iscc "/DSourceDir=$PublishDir" "/DOutputDir=$OutputRoot" "/DAppVersion=$AppVersion" $installerScript
    if ($LASTEXITCODE -ne 0) {
        throw "Inno Setup failed with exit code $LASTEXITCODE; installer creation stopped."
    }
    Write-Host "Created installer under $OutputRoot"
}

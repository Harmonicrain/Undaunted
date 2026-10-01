param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $installation) { throw 'C++ Build Tools are required for the native idle-policy test.' }
$developerCmd = Join-Path $installation 'Common7\Tools\VsDevCmd.bat'
# VsDevCmd.bat runs vswhere.exe by name. Without the installer folder on PATH it
# writes an error to stderr, which stops the build under Windows PowerShell 5.1.
$env:PATH = (Split-Path -Parent $vswhere) + ';' + $env:PATH
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
# The compiler needs the VS include/library environment. No file operations run
# in this command shell; all output paths are explicit and compiler-owned.
# Preserve the existing entry point while covering every isolated native policy.
$sources = @(Get-ChildItem -LiteralPath (Join-Path $repo 'UndauntedRuntime-1.12\test') -Filter '*.test.cpp' -File)
if (-not $sources.Count) { throw 'No native policy tests found.' }
foreach ($source in $sources) {
    $name = [IO.Path]::GetFileNameWithoutExtension($source.Name)
    $object = Join-Path $OutputDirectory "$name.obj"
    $executable = Join-Path $OutputDirectory "$name.exe"
    $command = '"' + $developerCmd + '" -arch=x64 -host_arch=x64 >nul && cl.exe /nologo /EHsc /std:c++20 /MT "' + $source.FullName + '" /Fo"' + $object + '" /Fe"' + $executable + '"'
    & cmd.exe /d /s /c $command
    if ($LASTEXITCODE -ne 0) { throw "Native policy compilation failed: $name" }
    & $executable
    if ($LASTEXITCODE -ne 0) { throw "Native policy checks failed: $name" }
    Write-Output "Native policy checks passed: $name"
}

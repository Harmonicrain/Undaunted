param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $installation) { throw 'C++ Build Tools are required for the native idle-policy test.' }
$developerCmd = Join-Path $installation 'Common7\Tools\VsDevCmd.bat'
$source = Join-Path $repo 'UndauntedRuntime-1.12\test\training-idle.test.cpp'
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$object = Join-Path $OutputDirectory 'training-idle-test.obj'
$executable = Join-Path $OutputDirectory 'training-idle-test.exe'
# The compiler needs the VS include/library environment. No file operations run
# in this command shell; all output paths are explicit and compiler-owned.
$command = '"' + $developerCmd + '" -arch=x64 -host_arch=x64 >nul && cl.exe /nologo /EHsc /std:c++20 /MT "' + $source + '" /Fo"' + $object + '" /Fe"' + $executable + '"'
& cmd.exe /d /s /c $command
if ($LASTEXITCODE -ne 0) { throw 'Native idle-policy compilation failed.' }
& $executable
if ($LASTEXITCODE -ne 0) { throw 'Native idle-policy checks failed.' }
Write-Output 'Native idle-policy grace, connected-player and unknown-count checks passed.'

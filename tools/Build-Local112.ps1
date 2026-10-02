# Build and optionally activate the complete 1.12 stack. Tests run in staged
# packages with disposable databases; no live .env or account files are copied.
#
# Paths come from tools/Local112Config.ps1: -DataRoot and -GameDirectory, the
# UNDAUNTED112_* environment variables, or tools/local112.json. -Test needs
# neither; -Deploy needs the game directory and -Restart the data root.
[CmdletBinding()]
param(
    [switch]$Test,
    [switch]$Deploy,
    [switch]$Restart,
    [Alias('LocalRoot')][string]$DataRoot,
    [string]$GameDirectory
)
$ErrorActionPreference = 'Stop'
if ($Restart -and -not $Deploy) { throw '-Restart requires -Deploy.' }
if ($Deploy) { $Test = $true }
. (Join-Path $PSScriptRoot 'Local112Config.ps1')
$config = Resolve-Local112Config -DataRoot $DataRoot -GameDirectory $GameDirectory `
    -RequireGameDirectory:$Deploy -RequireDataRoot:$Restart
$repo = $config.Repo
$client = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'client112.json') -Raw | ConvertFrom-Json
$gameExe = $null
if ($config.GameDirectory) {
    $gameExe = Join-Path $config.GameDirectory $client.executable
    if (Test-Path -LiteralPath $gameExe) {
        if ((Get-FileHash -LiteralPath $gameExe -Algorithm SHA256).Hash -ne $client.sha256) {
            throw 'Executable differs from the verified 1.12 CL392819 build. Review native addresses and signatures first.'
        }
    } elseif ($Deploy) { throw "Game executable missing: $gameExe" }
}

function Assert-RepoPath([string]$Path) {
    $absolute = [IO.Path]::GetFullPath($Path)
    if (-not $absolute.StartsWith($repo + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside this repository: $absolute"
    }
    return $absolute
}

function Invoke-Checked([string]$Executable, [string[]]$Arguments, [string]$Directory, [string]$Log) {
    Push-Location -LiteralPath $Directory
    try {
        & $Executable @Arguments 2>&1 | Out-File -LiteralPath $Log -Encoding utf8
        if ($LASTEXITCODE -ne 0) {
            Get-Content -LiteralPath $Log -Tail 28 | Write-Output
            throw "Command failed (exit $LASTEXITCODE). Log: $Log"
        }
    } finally { Pop-Location }
}

function Get-StackProcesses {
    $ports = Get-Local112Ports $config
    $owners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalPort -in @($ports.Metagame, $ports.Deploy, $ports.Xmpp) } |
        Select-Object -ExpandProperty OwningProcess -Unique)
    # Never output command lines: the game arguments contain account keys.
    return @(Get-CimInstance Win32_Process | Where-Object {
        ($_.Name -eq 'node.exe' -and $_.ProcessId -in $owners) -or
        ($_.ExecutablePath -and $_.ExecutablePath -eq $gameExe)
    })
}

function Wait-FileReleased([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        try {
            # Read access can succeed while an executable image is still mapped.
            # Require the write access that replacement needs, without changing bytes.
            $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
            $stream.Dispose()
            return
        } catch [IO.IOException] {
            if ([DateTime]::UtcNow -ge $deadline) { throw "DLL is still locked after shutdown: $Path" }
            Start-Sleep -Milliseconds 250
        }
    } while ($true)
}

function Copy-RuntimeFile([string]$Source, [string]$Target) {
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        try {
            # A scanner can reopen the file between the release check and copy.
            [IO.File]::Copy($Source, $Target, $true)
            return
        } catch [IO.IOException] {
            if ([DateTime]::UtcNow -ge $deadline) { throw "Runtime DLL replacement failed: $Target. $($_.Exception.Message)" }
            Start-Sleep -Milliseconds 250
        }
    } while ($true)
}

$node = (Get-Command node.exe).Source
$msbuild = $null
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (Test-Path -LiteralPath $vswhere) {
    $msbuild = & $vswhere -latest -products '*' -requires Microsoft.Component.MSBuild -find 'MSBuild\**\Bin\MSBuild.exe' | Select-Object -First 1
}
if (-not $msbuild) {
    $fallback = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\MSBuild.exe'
    if (Test-Path -LiteralPath $fallback) { $msbuild = $fallback }
}
if (-not $msbuild) { throw 'Install Visual Studio Build Tools with the v143 C++ toolset and Windows SDK.' }

# Include authored code, data, project configuration and tests in the identity.
$runtime = Join-Path $repo 'UndauntedRuntime-1.12'
$files = @(Get-ChildItem -LiteralPath $runtime -File | Where-Object { $_.Extension -in @('.cpp','.h','.hpp','.vcxproj','.sln','.bat') })
foreach ($folder in @('core','client','server','native','diagnostics','MinHook','test')) {
    $files += Get-ChildItem -LiteralPath (Join-Path $runtime $folder) -File -Recurse |
        Where-Object { $_.Extension -in @('.cpp','.c','.h','.hpp') -and $_.Name -ne 'BuildIdentity.generated.h' }
}
$files += Get-ChildItem -LiteralPath $PSScriptRoot -File -Recurse |
    Where-Object { $_.Extension -in @('.ps1','.mjs','.json') -and $_.Name -ne 'local112.json' }
foreach ($package in @('UndauntedMetagame','UndauntedDeployServer')) {
    $dir = Join-Path $repo $package
    foreach ($folder in @('src','test')) { $files += Get-ChildItem -LiteralPath (Join-Path $dir $folder) -File -Recurse }
    foreach ($name in @('package.json','package-lock.json','tsconfig.json')) { $files += Get-Item -LiteralPath (Join-Path $dir $name) }
}
$patchNotes = Join-Path $repo 'data\1.12\patchnotes'
$files += Get-ChildItem -LiteralPath $patchNotes -File -Recurse
$sourceLines = @($files | Sort-Object FullName -Unique | ForEach-Object {
    $_.FullName.Substring($repo.Length + 1).Replace('\','/') + ':' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
})
$sha = [Security.Cryptography.SHA256]::Create()
try { $sourceHash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(($sourceLines -join "`n"))))).Replace('-','') }
finally { $sha.Dispose() }
$commit = (& git -C $repo rev-parse HEAD).Trim()
$buildId = '112-' + $commit.Substring(0,8) + '-' + $sourceHash.Substring(0,12).ToLowerInvariant()
$stage = Assert-RepoPath (Join-Path $repo ('artifacts\' + $buildId + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss')))
New-Item -ItemType Directory -Path $stage -Force | Out-Null
$stagedData = Join-Path $stage 'data\1.12'
New-Item -ItemType Directory -Path $stagedData -Force | Out-Null
Copy-Item -LiteralPath $patchNotes -Destination $stagedData -Recurse
$sourceLines | Set-Content -LiteralPath (Join-Path $stage 'sources.sha256') -Encoding utf8
('#pragma once' + "`n" + '#define UNDAUNTED_BUILD_ID "' + $buildId + '"' + "`n") |
    Set-Content -LiteralPath (Join-Path $runtime 'native\BuildIdentity.generated.h') -Encoding ascii
Write-Output "Building $buildId (1.12 CL$($client.changelist))."

foreach ($package in @('UndauntedMetagame','UndauntedDeployServer')) {
    $dir = Join-Path $repo $package
    $output = Assert-RepoPath (Join-Path $stage $package)
    New-Item -ItemType Directory -Path $output -Force | Out-Null
    $compiler = Join-Path $dir 'node_modules\typescript\bin\tsc'
    Invoke-Checked $node @($compiler,'--outDir',(Join-Path $output 'dist')) $dir (Join-Path $stage "$package-build.log")
    if ($Test) {
        Copy-Item -LiteralPath (Join-Path $dir 'test'), (Join-Path $dir 'src') -Destination $output -Recurse
        $oldNodePath = $env:NODE_PATH
        try {
            $env:NODE_PATH = Join-Path $dir 'node_modules'
            $testFiles = @(Get-ChildItem -Path (Join-Path $output 'test\*.test.js') -File | Select-Object -ExpandProperty FullName)
            if ($testFiles.Count -eq 0) { throw "No tests found in $package" }
            Invoke-Checked $node (@('--test') + $testFiles) $output (Join-Path $stage "$package-test.log")
            Get-Content -LiteralPath (Join-Path $stage "$package-test.log") -Tail 8 | Write-Output
        } finally { $env:NODE_PATH = $oldNodePath }
    }
    Write-Output "$package compiled$(if ($Test) { ' and tested' })."
}
Invoke-Checked $msbuild @('MysticParadox.sln','/t:Rebuild','/p:Configuration=Release','/p:Platform=x64','/nologo','/verbosity:minimal') $runtime (Join-Path $stage 'runtime-build.log')
if ($Test) {
    Invoke-Checked 'powershell.exe' @('-NoProfile','-File',(Join-Path $PSScriptRoot 'Test-TrainingIdle112.ps1'),'-OutputDirectory',(Join-Path $stage 'native-tests')) $repo (Join-Path $stage 'native-tests.log')
    Get-Content -LiteralPath (Join-Path $stage 'native-tests.log') -Tail 2 | Write-Output
    Invoke-Checked 'powershell.exe' @('-NoProfile','-File',(Join-Path $PSScriptRoot 'Test-WorldMemoryLogs112.ps1')) $repo (Join-Path $stage 'memory-log-tests.log')
    Get-Content -LiteralPath (Join-Path $stage 'memory-log-tests.log') -Tail 1 | Write-Output
}
$dll = Join-Path $runtime 'x64\Release\MysticParadox.dll'
Copy-Item -LiteralPath $dll -Destination (Join-Path $stage 'UndauntedInternalServer.dll')
$dllHash = (Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash
$manifest = [ordered]@{
    schema = 1; buildId = $buildId; createdUtc = [DateTime]::UtcNow.ToString('o')
    commit = $commit; sourceSha256 = $sourceHash; client = $client
    toolset = 'v143'; configuration = 'Release'; testsPassed = [bool]$Test
    runtimeSha256 = $dllHash; deployed = $false; restarted = $false; copies = @()
}
$manifestPath = Join-Path $stage 'manifest.json'
$manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding utf8

if ($Deploy) {
    $processes = @(Get-StackProcesses)
    if ($processes.Count -and -not $Restart) { throw 'The 1.12 stack is running. Use -Deploy -Restart to activate the checked build.' }
    if ($Restart) {
        # Stop services before worlds so the deploy watchdog cannot respawn them.
        foreach ($process in ($processes | Sort-Object @{Expression={ if ($_.Name -eq 'node.exe') { 0 } else { 1 } }})) {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
        }
        foreach ($process in $processes) { Wait-Process -Id $process.ProcessId -Timeout 10 -ErrorAction SilentlyContinue }
    }
    $targets = @(Join-Path $config.GameDirectory 'UndauntedInternalServer.dll')
    foreach ($target in $targets) { Wait-FileReleased $target }
    $previous = Assert-RepoPath (Join-Path $stage 'previous')
    New-Item -ItemType Directory -Path $previous -Force | Out-Null
    foreach ($package in @('UndauntedMetagame','UndauntedDeployServer')) {
        $destination = Assert-RepoPath (Join-Path $repo "$package\dist")
        if (Test-Path -LiteralPath $destination) {
            Move-Item -LiteralPath $destination -Destination (Assert-RepoPath (Join-Path $previous "$package-dist"))
        }
        Copy-Item -LiteralPath (Join-Path $stage "$package\dist") -Destination $destination -Recurse
    }
    for ($index = 0; $index -lt $targets.Count; $index++) {
        $target = $targets[$index]
        if (Test-Path -LiteralPath $target) { Copy-Item -LiteralPath $target -Destination (Join-Path $previous "runtime-$index.dll") }
        Copy-RuntimeFile $dll $target
        $hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
        if ($hash -ne $dllHash) { throw "Deployed DLL hash mismatch: $target" }
        $manifest.copies += @{ path = $target; sha256 = $hash }
    }
    $manifest.deployed = $true
    $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding utf8
    if ($Restart) {
        # The servers the start script launches inherit whatever inheritable
        # handles they are given. Read through a pipe, the start script's output
        # never ended while they ran, so this step waited until the servers
        # stopped. Keep this script's own handles out of them, send the start
        # script's output to files, and wait only for the start script.
        Add-Type -Namespace Undaunted -Name Handles -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern System.IntPtr GetStdHandle(int n);
[DllImport("kernel32.dll")] public static extern bool SetHandleInformation(System.IntPtr h, int mask, int flags);
'@
        foreach ($stdHandle in -10, -11, -12) {
            [void][Undaunted.Handles]::SetHandleInformation([Undaunted.Handles]::GetStdHandle($stdHandle), 1, 0)
        }
        $start = Join-Path $PSScriptRoot 'Start-Local112.ps1'
        $restartLog = Join-Path $stage 'restart.log'
        $restartArgs = @('-NoProfile', '-File', "`"$start`"", '-DataRoot', "`"$($config.DataRoot)`"", '-GameDirectory', "`"$($config.GameDirectory)`"")
        $restartProcess = Start-Process -FilePath 'powershell.exe' -ArgumentList $restartArgs -WorkingDirectory $repo -WindowStyle Hidden `
            -RedirectStandardOutput $restartLog -RedirectStandardError (Join-Path $stage 'restart.err.log') -PassThru
        $null = $restartProcess.Handle   # keeps the exit code readable once it exits
        $restartProcess.WaitForExit()
        if ($restartProcess.ExitCode -ne 0) {
            Get-Content -LiteralPath $restartLog -Tail 20 | Write-Output
            throw "Restart failed (exit $($restartProcess.ExitCode)). Log: $restartLog"
        }
        $manifest.restarted = $true
        $manifest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding utf8
        Get-Content -LiteralPath (Join-Path $stage 'restart.log') -Tail 6 | Write-Output
        # Every world loaded this build, listens and installed its hooks and patches.
        Invoke-Checked 'powershell.exe' @('-NoProfile','-File',(Join-Path $PSScriptRoot 'Test-WorldStartup112.ps1'),
            '-GameDirectory',$config.GameDirectory,'-BuildId',$buildId) $repo (Join-Path $stage 'startup-check.log')
        Get-Content -LiteralPath (Join-Path $stage 'startup-check.log') | Write-Output
    }
}
Write-Output "Build manifest: $manifestPath"

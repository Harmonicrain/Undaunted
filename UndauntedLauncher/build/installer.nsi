; Native per-user installer. The GUID and registry layout retain compatibility
; with the original Electron launcher. No Electron tooling or runtime is used.
Unicode true
RequestExecutionLevel user
SetCompressor /SOLID lzma
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "x64.nsh"
Name "${PRODUCT_NAME}"
OutFile "${INSTALLER_FILE}"
InstallDir "$LOCALAPPDATA\Programs\${PRODUCT_NAME}"
InstallDirRegKey HKCU "Software\${APP_GUID}" "InstallLocation"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${PRODUCT_NAME}"
VIAddVersionKey "FileDescription" "${PRODUCT_NAME} Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Undaunted contributors"
!define INSTALL_KEY "Software\${APP_GUID}"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_GUID}"
!define MUI_ICON "${ICON_FILE}"
!define MUI_UNICON "${ICON_FILE}"
!define MUI_WELCOMEFINISHPAGE_BITMAP "${SIDEBAR_FILE}"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "${SIDEBAR_FILE}"
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION LaunchApp
!if ${RUN_AFTER_FINISH} == 0
  !define MUI_FINISHPAGE_RUN_NOTCHECKED
!endif
!define MUI_FINISHPAGE_SHOWREADME ""
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Create a desktop shortcut"
!define MUI_FINISHPAGE_SHOWREADME_FUNCTION DesktopShortcut
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
Var Parameters
Var OldDirectory
Var OldUninstaller
Var LockAttempts

Function DetectWebView2
  SetRegView 32
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${If} $0 == ""
  ${OrIf} $0 == "0.0.0.0"
    ReadRegStr $0 HKCU "SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${EndIf}
  SetRegView 64
FunctionEnd

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "This launcher requires 64-bit Windows."
    SetErrorLevel 1
    Quit
  ${EndIf}
  SetRegView 64
  SetShellVarContext current
  ${GetParameters} $Parameters
  ReadRegStr $OldDirectory HKCU "${INSTALL_KEY}" "InstallLocation"
  ${If} $OldDirectory != ""
    ; InstallDirRegKey may run before the 64-bit registry view is selected.
    ; Preserve an explicit final /D= argument, otherwise reuse the old folder.
    ClearErrors
    ${GetOptions} $Parameters "/D=" $1
    ${If} ${Errors}
      StrCpy $INSTDIR $OldDirectory
    ${EndIf}
  ${EndIf}
  ${If} $OldDirectory == ""
    ReadRegStr $0 HKLM "${INSTALL_KEY}" "InstallLocation"
    ${If} $0 != ""
      MessageBox MB_OK|MB_ICONSTOP "This installer supports per-user installations. Remove the existing all-users installation with its original uninstaller before installing for this user."
      SetErrorLevel 1
      Quit
    ${EndIf}
  ${EndIf}
  Call DetectWebView2
  ${If} $0 == ""
  ${OrIf} $0 == "0.0.0.0"
    InitPluginsDir
    File /oname=$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe "${WEBVIEW_BOOTSTRAPPER}"
    ExecWait '"$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe" /silent /install' $1
    Call DetectWebView2
    ${If} $0 == ""
    ${OrIf} $0 == "0.0.0.0"
      MessageBox MB_OK|MB_ICONSTOP "Microsoft Edge WebView2 could not be installed. Connect to the internet, install WebView2, and run this update again. Your existing launcher has not been removed."
      SetErrorLevel 1
      Quit
    ${EndIf}
  ${EndIf}
FunctionEnd

Function CheckLauncherClosed
  StrCpy $LockAttempts 0
  retry:
  IfFileExists "$INSTDIR\${PRODUCT_NAME}.exe" 0 done
  System::Call 'kernel32::CreateFileW(w "$INSTDIR\${PRODUCT_NAME}.exe", i 0x40000000, i 3, p 0, i 3, i 0, p 0) p.r0'
  ${If} $0 == -1
    IntOp $LockAttempts $LockAttempts + 1
    ${If} $LockAttempts < 20
      Sleep 500
      Goto retry
    ${EndIf}
    MessageBox MB_OK|MB_ICONSTOP "Close the launcher and check the installation folder permissions before updating."
    SetErrorLevel 1
    Quit
  ${EndIf}
  System::Call 'kernel32::CloseHandle(p r0)'
  done:
FunctionEnd

Function LaunchApp
  Exec '"$INSTDIR\${PRODUCT_NAME}.exe" --updated'
FunctionEnd
Function DesktopShortcut
  CreateShortcut "$DESKTOP\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_NAME}.exe"
FunctionEnd

Section Install
  Call CheckLauncherClosed
  ${If} $OldDirectory != ""
    StrCpy $2 $INSTDIR
    StrCpy $INSTDIR $OldDirectory
    Call CheckLauncherClosed
    StrCpy $INSTDIR $2
    InitPluginsDir
    StrCpy $OldUninstaller "$OldDirectory\Uninstall ${PRODUCT_NAME}.exe"
    IfFileExists "$OldUninstaller" 0 missing_uninstaller
    ClearErrors
    CopyFiles /SILENT "$OldUninstaller" "$PLUGINSDIR\old-uninstaller.exe"
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONSTOP "The existing launcher could not be prepared for updating."
      SetErrorLevel 1
      Quit
    ${EndIf}
    ClearErrors
    ExecWait '"$PLUGINSDIR\old-uninstaller.exe" /S /KEEP_APP_DATA /currentuser --updated --keep-shortcuts _?=$OldDirectory' $0
    ${If} ${Errors}
    ${OrIf} $0 != 0
      MessageBox MB_OK|MB_ICONSTOP "The existing launcher could not be updated. Close it and try again."
      SetErrorLevel 1
      Quit
    ${EndIf}
    Goto old_removed
    missing_uninstaller:
      MessageBox MB_OK|MB_ICONSTOP "The existing launcher uninstaller is missing. Repair or uninstall it before updating."
      SetErrorLevel 1
      Quit
    old_removed:
  ${EndIf}
  SetOutPath "$INSTDIR"
  File /r "${PAYLOAD_DIR}\*"
  WriteUninstaller "$INSTDIR\Uninstall ${PRODUCT_NAME}.exe"
  WriteRegStr HKCU "${INSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${INSTALL_KEY}" "ShortcutName" "${PRODUCT_NAME}"
  WriteRegStr HKCU "${INSTALL_KEY}" "KeepShortcuts" "true"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "${PRODUCT_NAME} ${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall ${PRODUCT_NAME}.exe"'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
  !if ${CREATE_SHORTCUTS} == 1
    CreateShortcut "$SMPROGRAMS\${PRODUCT_NAME}.lnk" "$INSTDIR\${PRODUCT_NAME}.exe"
  !endif
  ${If} ${Silent}
    ClearErrors
    ${GetOptions} $Parameters "--force-run" $0
    ${IfNot} ${Errors}
      Call LaunchApp
    ${EndIf}
  ${EndIf}
SectionEnd

Function un.onInit
  SetRegView 64
  SetShellVarContext current
  ${GetParameters} $Parameters
FunctionEnd
Section Uninstall
  ClearErrors
  ${GetOptions} $Parameters "--updated" $0
  ${If} ${Errors}
    Delete "$DESKTOP\${PRODUCT_NAME}.lnk"
    Delete "$SMPROGRAMS\${PRODUCT_NAME}.lnk"
  ${EndIf}
  Delete "$INSTDIR\${PRODUCT_NAME}.exe"
  RMDir /r "$INSTDIR\launcher"
  Delete "$INSTDIR\LICENSE.txt"
  Delete "$INSTDIR\NOTICE.md"
  Delete "$INSTDIR\ADDITIONAL_TERMS.md"
  Delete "$INSTDIR\SOURCE.txt"
  Delete "$INSTDIR\CHANGELOG.md"
  Delete "$INSTDIR\Uninstall ${PRODUCT_NAME}.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${INSTALL_KEY}"
  DeleteRegKey HKCU "${UNINSTALL_KEY}"
SectionEnd

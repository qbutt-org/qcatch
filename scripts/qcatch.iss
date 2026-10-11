#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef BundleDir
  #error BundleDir is required
#endif
#ifndef ArtifactDir
  #error ArtifactDir is required
#endif

[Setup]
AppId={{AC76E2E1-311A-4E7D-BC91-90B7F591FC27}
AppName=qcatch
AppVersion={#AppVersion}
AppPublisher=qbutt-org
AppPublisherURL=https://qbutt-org.github.io/qcatch/
AppSupportURL=https://github.com/qbutt-org/qcatch/issues
AppUpdatesURL=https://github.com/qbutt-org/qcatch/releases
DefaultDirName={localappdata}\Programs\qcatch
DefaultGroupName=qcatch
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir={#ArtifactDir}
OutputBaseFilename=qcatch-{#AppVersion}-windows-x64-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
CloseApplications=yes
CloseApplicationsFilter=qcatch.exe
RestartApplications=no
SetupMutex=qcatch-setup
UninstallDisplayIcon={app}\qcatch.exe

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
russian.UninstallQcatch=Удалить qcatch
english.UninstallQcatch=Uninstall qcatch
russian.ConnectBrowser=Подключить расширение qcatch к браузеру
english.ConnectBrowser=Connect qcatch to your browser
russian.StopFailure=Не удалось остановить qcatch. Завершите текущие загрузки и повторите установку.
english.StopFailure=Could not stop qcatch. Finish the current downloads and run setup again.

[Files]
Source: "{#BundleDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Registry]
Root: HKCU; Subkey: "Software\qbutt-org\qcatch"; ValueType: string; ValueName: "InstallDir"; ValueData: "{app}"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\qbutt-org\qcatch"; ValueType: string; ValueName: "Version"; ValueData: "{#AppVersion}"
Root: HKCU; Subkey: "Software\qbutt-org\qcatch"; ValueType: dword; ValueName: "ProtocolVersion"; ValueData: "1"
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\App Paths\qcatch.exe"; ValueType: string; ValueName: ""; ValueData: "{app}\qcatch.exe"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "qcatch"; ValueData: """{app}\qcatch.exe"" --run"; Flags: uninsdeletevalue
Root: HKCU; Subkey: "Software\Microsoft\Edge\NativeMessagingHosts\org.qbutt.qcatch"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\Google\Chrome\NativeMessagingHosts\org.qbutt.qcatch"; Flags: uninsdeletekey

[Icons]
Name: "{group}\qcatch"; Filename: "{app}\setup.html"
Name: "{group}\{cm:UninstallQcatch}"; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\qcatch.exe"; Parameters: "--register-native"; Flags: runhidden waituntilterminated
Filename: "{app}\qcatch.exe"; Parameters: "--run"; Flags: nowait runasoriginaluser
Filename: "{app}\setup.html"; Description: "{cm:ConnectBrowser}"; Flags: shellexec postinstall skipifsilent

[UninstallRun]
Filename: "{app}\qcatch.exe"; Parameters: "--stop"; Flags: runhidden waituntilterminated; RunOnceId: "qcatch-stop"

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var ExitCode: Integer;
begin
  Result := '';
  if FileExists(ExpandConstant('{app}\qcatch.exe')) then
    if not Exec(ExpandConstant('{app}\qcatch.exe'), '--stop', '', SW_HIDE, ewWaitUntilTerminated, ExitCode) or (ExitCode <> 0) then
      Result := ExpandConstant('{cm:StopFailure}');
end;

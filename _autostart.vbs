' study-os - hidden launcher used by the logon autostart shortcut.
'
' Every path is derived from this file's own location, so the project
' folder can be moved or renamed without editing anything here.
' ASCII only: kept that way so no codepage can garble it.

Option Explicit

Dim fso, sh, dir
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir

' 0 = hidden window, False = do not wait for it to finish.
sh.Run "cmd /c """ & dir & "\_autostart.cmd""", 0, False

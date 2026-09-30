Option Explicit
Dim shell, files, folder
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
folder = files.GetParentFolderName(WScript.ScriptFullName)
If Not files.FileExists(folder & "\PetDesk.exe") Then
  MsgBox "Extract the complete ZIP first, then run this file beside PetDesk.exe.", 48, "PetDesk"
  WScript.Quit 1
End If
shell.Run """" & folder & "\PetDesk.exe"" --maskdesk", 1, False

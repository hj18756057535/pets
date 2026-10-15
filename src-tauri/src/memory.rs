use serde_json::{json, Value};

// Ask WebView2 to release caches for hidden/minimized windows while retaining
// the document and unsaved forms. Older runtimes may not support this API.
pub fn update_webview_budget(window: &tauri::WebviewWindow) {
    #[cfg(windows)]
    {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
            COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
        };
        use windows_core::Interface;
        let window = window.clone();
        let current = window.clone();
        let _ = window.with_webview(move |webview| unsafe {
            let controller = webview.controller();
            let Ok(core) = controller.CoreWebView2() else { return; };
            let Ok(core) = core.cast::<ICoreWebView2_19>() else { return; };
            // Tauri hides the parent HWND; the controller's IsVisible can stay true.
            let active = current.is_visible().unwrap_or(true) && !current.is_minimized().unwrap_or(false);
            // Propagate host visibility so Chromium can stop hidden rendering and
            // deliver visibilitychange (hiding the HWND alone is insufficient).
            let _ = controller.SetIsVisible(active);
            let level = if active { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL }
                else { COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW };
            if let Err(error) = core.SetMemoryUsageTargetLevel(level) {
                super::startup_stage(&format!("webview memory budget unavailable: {error}"));
            }
        });
    }
    #[cfg(not(windows))]
    let _ = window;
}

pub fn set_visible(window: &tauri::WebviewWindow, visible: bool) -> tauri::Result<()> {
    if visible { window.show()?; } else { window.hide()?; }
    update_webview_budget(window);
    Ok(())
}

#[cfg(all(debug_assertions, windows))]
pub async fn webview_snapshot(window: &tauri::WebviewWindow) -> Result<Value, String> {
    use webview2_com::ExecuteScriptCompletedHandler;
    let (send, receive) = std::sync::mpsc::channel();
    window.with_webview(move |webview| unsafe {
        let script = windows_core::HSTRING::from("({url:location.href,api:!!window.petdesk,tauri:!!window.__TAURI__,ready:!!window.__ready,error:window.__loadError||null,body:document.documentElement.outerHTML.slice(0,2500)})");
        if let Ok(core) = webview.controller().CoreWebView2() {
            let mut browser_pid = 0;
            let _ = core.BrowserProcessId(&mut browser_pid);
            let _ = core.ExecuteScript(&script,&ExecuteScriptCompletedHandler::create(Box::new(move |_, result| {
                let _ = send.send((result,browser_pid)); Ok(())
            })));
        }
    }).map_err(|e|e.to_string())?;
    let (text,browser_pid) = tauri::async_runtime::spawn_blocking(move || receive.recv_timeout(std::time::Duration::from_secs(5)))
        .await.map_err(|e|e.to_string())?.map_err(|e|e.to_string())?;
    let mut result: Value = serde_json::from_str(&text).map_err(|e|e.to_string())?;
    result["browserProcessId"] = json!(browser_pid);
    Ok(result)
}

#[cfg(all(debug_assertions, windows))]
pub async fn webview_budget(window: &tauri::WebviewWindow) -> Result<i32, String> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_19;
    use windows_core::Interface;
    let (send, receive) = std::sync::mpsc::channel();
    window.with_webview(move |webview| {
        let result = (|| unsafe {
            let core = webview.controller().CoreWebView2()?.cast::<ICoreWebView2_19>()?;
            let mut level = Default::default();
            core.MemoryUsageTargetLevel(&mut level)?;
            Ok::<_, windows_core::Error>(level.0)
        })();
        let _ = send.send(result.map_err(|e| e.to_string()));
    }).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        receive.recv_timeout(std::time::Duration::from_secs(5)).map_err(|e| e.to_string())?
    }).await.map_err(|e| e.to_string())?
}

#[cfg(windows)]
pub fn inspect(trim: bool) -> Result<Value, String> {
    use std::{collections::HashSet, mem::{size_of, zeroed}};
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS},
            ProcessStatus::{K32EmptyWorkingSet, K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS_EX},
            SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX},
            Threading::{OpenProcess, PROCESS_QUERY_INFORMATION, PROCESS_VM_READ, PROCESS_SET_QUOTA},
        },
    };
    unsafe {
        let mut system: MEMORYSTATUSEX = zeroed();
        system.dwLength = size_of::<MEMORYSTATUSEX>() as u32;
        if GlobalMemoryStatusEx(&mut system) == 0 { return Err(std::io::Error::last_os_error().to_string()); }
        let mut owned = HashSet::from([std::process::id()]);
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE { return Err(std::io::Error::last_os_error().to_string()); }
        let mut entry: PROCESSENTRY32W = zeroed();
        entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
        let mut children = Vec::new();
        let mut more = Process32FirstW(snapshot, &mut entry);
        while more != 0 {
            let end = entry.szExeFile.iter().position(|c| *c == 0).unwrap_or(entry.szExeFile.len());
            if String::from_utf16_lossy(&entry.szExeFile[..end]).eq_ignore_ascii_case("msedgewebview2.exe") {
                children.push((entry.th32ProcessID, entry.th32ParentProcessID));
            }
            more = Process32NextW(snapshot, &mut entry);
        }
        CloseHandle(snapshot);
        loop {
            let before = owned.len();
            for (pid, parent) in &children { if owned.contains(parent) { owned.insert(*pid); } }
            if owned.len() == before { break; }
        }
        let mut before = 0u64;
        let mut after = 0u64;
        let mut private_bytes = 0u64;
        let mut measured = 0;
        let mut trimmed = 0;
        for pid in owned {
            let rights = PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | if trim { PROCESS_SET_QUOTA } else { 0 };
            let process = OpenProcess(rights, 0, pid);
            if process.is_null() { continue; }
            let mut counters: PROCESS_MEMORY_COUNTERS_EX = zeroed();
            let size = size_of::<PROCESS_MEMORY_COUNTERS_EX>() as u32;
            counters.cb = size;
            if K32GetProcessMemoryInfo(process, (&mut counters as *mut PROCESS_MEMORY_COUNTERS_EX).cast(), size) != 0 {
                measured += 1;
                private_bytes += counters.PrivateUsage as u64;
                before += counters.WorkingSetSize as u64;
                if trim && K32EmptyWorkingSet(process) != 0 { trimmed += 1; }
                let _ = K32GetProcessMemoryInfo(process, (&mut counters as *mut PROCESS_MEMORY_COUNTERS_EX).cast(), size);
                after += counters.WorkingSetSize as u64;
            }
            CloseHandle(process);
        }
        if trim && trimmed == 0 { return Err("暂时无法整理桌宠内存，请稍后重试".into()); }
        Ok(json!({"total":system.ullTotalPhys,"available":system.ullAvailPhys,
            "used":system.ullTotalPhys.saturating_sub(system.ullAvailPhys),"percent":system.dwMemoryLoad,
            "appWorkingSet":after,"appPrivateBytes":private_bytes,"processCount":measured,"trimmed":trimmed,
            "reducedWorkingSet":before.saturating_sub(after)}))
    }
}

#[cfg(not(windows))]
pub fn inspect(_trim: bool) -> Result<Value, String> { Err("当前内存查看仅支持 Windows".into()) }

// Shared non-native date/time controls; the vendor scripts are local bundled assets.
export function setupDateTimePickers(root) {
  if (!window.flatpickr) throw new Error('日期时间控件未加载，请重新打开面板');
  const instances = new Map();
  root.querySelectorAll('[data-work-picker], [data-picker]').forEach(input => {
    const isTime = (input.dataset.workPicker || input.dataset.picker) === 'time';
    const instance = window.flatpickr(input, {
      locale: window.flatpickr.l10ns.zh,
      disableMobile: true,
      allowInput: false,
      static: true,
      dateFormat: isTime ? 'H:i' : 'Y-m-d',
      ariaDateFormat: 'Y年m月d日',
      enableTime: isTime,
      noCalendar: isTime,
      time_24hr: true,
      minuteIncrement: 5,
      defaultHour: 9,
      defaultMinute: 0,
      monthSelectorType: 'static',
    });
    instances.set(input, instance);
    input.closest('dialog')?.addEventListener('close', () => instance.close());
  });
  return {
    set(input, value) { instances.get(input)?.setDate(value || null, false); },
    clear(input) { instances.get(input)?.clear(); },
    close() { instances.forEach(instance => instance.close()); },
  };
}

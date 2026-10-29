// Editable category menu shared by the quick entry and task editor.
export function categoryChoices(options, query = '', showAll = false) {
  const typed = query.trim();
  const key = typed.toLowerCase();
  const choices = options.filter(value => showAll || value.toLowerCase().includes(key)).map(value => ({value, create: false}));
  if (typed && typed.length <= 30 && !options.some(value => value.toLowerCase() === key)) choices.push({value: typed, create: true});
  return choices;
}

export function setupCategoryPickers(root, getOptions) {
  const menus = [];
  root.querySelectorAll('[data-category-picker]').forEach(wrapper => {
    const input = wrapper.querySelector('input');
    const toggle = wrapper.querySelector('[data-category-toggle]');
    const list = wrapper.querySelector('[role=listbox]');
    let choices = [], active = -1, all = true;
    function close() {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false'); toggle.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant'); active = -1;
    }
    function highlight(index) {
      active = index;
      [...list.children].forEach((el, i) => { el.classList.toggle('is-active', i === active); });
      if (active < 0) input.removeAttribute('aria-activedescendant');
      else { input.setAttribute('aria-activedescendant', list.children[active].id); list.children[active].scrollIntoView({block: 'nearest'}); }
    }
    function choose(index) {
      if (input.disabled || !choices[index]) return;
      input.value = choices[index].value; close(); input.focus();
      input.dispatchEvent(new Event('change', {bubbles: true}));
    }
    function render() {
      choices = categoryChoices(getOptions(), input.value, all);
      list.replaceChildren();
      choices.forEach((choice, index) => {
        const item = document.createElement('div');
        item.id = `${list.id}-${index}`; item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', String(!choice.create && choice.value === input.value.trim()));
        item.className = 'category-option'; item.textContent = choice.create ? `＋ 使用新分类「${choice.value}」` : choice.value;
        item.addEventListener('pointerdown', event => event.preventDefault());
        item.addEventListener('click', () => choose(index)); list.append(item);
      });
      if (!choices.length) { const empty = document.createElement('p'); empty.className = 'category-empty'; empty.textContent = '输入名称即可添加分类'; list.append(empty); }
      highlight(-1);
    }
    function open(showAll) {
      if (input.disabled) return;
      menus.forEach(menu => { if (menu.input !== input) menu.close(); });
      all = showAll; render(); list.hidden = false;
      input.setAttribute('aria-expanded', 'true'); toggle.setAttribute('aria-expanded', 'true');
    }
    input.addEventListener('click', () => open(true));
    input.addEventListener('input', () => open(false));
    toggle.addEventListener('pointerdown', event => event.preventDefault());
    toggle.addEventListener('click', () => { if (list.hidden || !all) { input.focus(); open(true); } else close(); });
    input.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault(); if (list.hidden) open(true);
        if (choices.length) highlight(active < 0 ? (event.key === 'ArrowDown' ? 0 : choices.length - 1) : (active + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length);
      } else if (event.key === 'Enter' && !list.hidden && active >= 0) { event.preventDefault(); choose(active); }
      else if (event.key === 'Escape' && !list.hidden) { event.preventDefault(); event.stopPropagation(); close(); }
      else if (event.key === 'Tab') close();
    });
    wrapper.addEventListener('focusout', event => { if (!wrapper.contains(event.relatedTarget)) close(); });
    input.closest('dialog')?.addEventListener('close', close);
    menus.push({input, close, sync() { if (!list.hidden) render(); }});
  });
  root.addEventListener('pointerdown', event => { menus.forEach(menu => { if (!event.target.closest('[data-category-picker]')?.contains(menu.input)) menu.close(); }); });
  return {close() { menus.forEach(menu => menu.close()); }, sync() { menus.forEach(menu => menu.sync()); }};
}

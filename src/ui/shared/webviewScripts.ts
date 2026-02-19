/**
 * Shared JS for all webview panels.
 * Provides custom select/combobox initialization, dropdown close handler,
 * and a client-side escapeHtml utility.
 *
 * Usage: Include the returned string in a <script> tag before panel-specific JS.
 * Then call initCustomSelects() and/or initCustomComboboxes() from your IIFE.
 */
export function baseWebviewJs(): string {
  return `
    function escapeHtml(str) {
      return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    }

    function selectCustomOption(wrapper, value) {
      var hiddenInput = wrapper.querySelector('input[type="hidden"]');
      var textEl = wrapper.querySelector('.custom-select-text');
      var options = wrapper.querySelectorAll('.custom-select-option');
      for (var i = 0; i < options.length; i++) {
        options[i].classList.remove('selected');
        if (options[i].dataset.value === value) {
          options[i].classList.add('selected');
          textEl.textContent = options[i].textContent;
        }
      }
      hiddenInput.value = value;
      wrapper.classList.remove('open');
      hiddenInput.dispatchEvent(new Event('change', { bubbles: true }));
      hiddenInput.dispatchEvent(new Event('input', { bubbles: true }));
    }

    document.addEventListener('click', function(e) {
      if (!e.target.closest('.custom-select')) {
        var openSelects = document.querySelectorAll('.custom-select.open');
        for (var i = 0; i < openSelects.length; i++) {
          openSelects[i].classList.remove('open');
        }
      }
      if (!e.target.closest('.custom-combobox')) {
        var openCombos = document.querySelectorAll('.custom-combobox.open');
        for (var i = 0; i < openCombos.length; i++) {
          openCombos[i].classList.remove('open');
        }
      }
    });

    function initCustomSelects(onOptionClick) {
      var customSelects = document.querySelectorAll('.custom-select');
      for (var cs = 0; cs < customSelects.length; cs++) {
        (function(wrapper) {
          var trigger = wrapper.querySelector('.custom-select-trigger');
          trigger.addEventListener('click', function(e) {
            e.stopPropagation();
            var openSelects = document.querySelectorAll('.custom-select.open');
            for (var j = 0; j < openSelects.length; j++) {
              if (openSelects[j] !== wrapper) openSelects[j].classList.remove('open');
            }
            wrapper.classList.toggle('open');
          });
          trigger.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              wrapper.classList.toggle('open');
            } else if (e.key === 'Escape') {
              wrapper.classList.remove('open');
            }
          });
          wrapper.querySelector('.custom-select-dropdown').addEventListener('click', function(e) {
            var opt = e.target.closest('.custom-select-option');
            if (!opt) return;
            if (onOptionClick) {
              onOptionClick(wrapper, opt);
            } else {
              selectCustomOption(wrapper, opt.dataset.value);
            }
          });
        })(customSelects[cs]);
      }
    }

    function initCustomComboboxes() {
      var combos = document.querySelectorAll('.custom-combobox');
      for (var ci = 0; ci < combos.length; ci++) {
        (function(combo) {
          var input = combo.querySelector('input[type="text"]');
          var dropdown = combo.querySelector('.custom-select-dropdown');
          var allOptions = dropdown.querySelectorAll('.custom-select-option');

          function showFiltered(filter) {
            var count = 0;
            for (var i = 0; i < allOptions.length; i++) {
              var match = !filter || allOptions[i].textContent.toLowerCase().indexOf(filter.toLowerCase()) !== -1;
              allOptions[i].style.display = match ? '' : 'none';
              if (match) count++;
            }
            if (count > 0) { combo.classList.add('open'); } else { combo.classList.remove('open'); }
          }

          input.addEventListener('focus', function() { showFiltered(input.value); });
          input.addEventListener('input', function() { showFiltered(input.value); });
          input.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') combo.classList.remove('open');
          });

          for (var oi = 0; oi < allOptions.length; oi++) {
            (function(opt) {
              opt.addEventListener('mousedown', function(e) {
                e.preventDefault();
                input.value = opt.dataset.value;
                combo.classList.remove('open');
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
              });
            })(allOptions[oi]);
          }
        })(combos[ci]);
      }
    }`;
}
